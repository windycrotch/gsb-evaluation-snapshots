"""
Tests for ProcessorChain cache lifecycle:

* main path and bit-identical reuse on unchanged repeated calls;
* unified-kernel invalidation when a processor's key configuration changes
  (sampling rate, SH order, array geometry, encoder type);
* clean recovery after a failed ``process`` (no half-built kernel / coefficients
  leak into the next call);
* thread-safe single first build and identical error propagation to all waiters;
* lazy ASM coefficient build atomicity.
"""
import threading

import numpy as np
import pytest

from shroom.acoustics.processors import (
    ProcessorChain,
    ArrayDecoder,
    ASMEncoder,
    BSMEncoder,
    BinauralDecoder,
)
from shroom.acoustics.spatial_signal import SpatialSignal
from shroom.encoders.asm import ASM
from shroom.encoders.bsm import BSM


# ---------------------------------------------------------------------------
# Construction helpers
# ---------------------------------------------------------------------------

def _amb_signal(fs=16000, sh_order=1, n_samples=320, seed=0):
    """A deterministic time-domain Ambisonics (SH) signal, shape (1, L, T)."""
    rng = np.random.default_rng(seed)
    n_sh = (sh_order + 1) ** 2
    data = rng.standard_normal((1, n_sh, n_samples))
    return SpatialSignal(
        data=data, fs=fs, is_time=True, is_space=False, grid=None
    )


def _hrtf(fs=16000, sh_order=1, n_samples=128):
    """Deterministic mock HRTF in time-domain SH, shape (2, L, T)."""
    rng = np.random.default_rng(7)
    n_sh = (sh_order + 1) ** 2
    data = rng.standard_normal((2, n_sh, n_samples)) * 0.1
    data[:, 0, 0] += 1.0
    return SpatialSignal(
        data=data, fs=fs, is_time=True, is_space=False, grid=None
    )


def _build_chain_parts(
    make_spherical_array,
    fs=16000,
    n_mics=6,
    radius=0.1,
    source_points=50,
    array_sh_order=1,
    asm_sh_order=1,
    hrtf_sh_order=1,
    spectrally_equalized=False,
):
    """Build a fresh (array, asm, hrtf, chain) tuple for a full ASM chain."""
    array = make_spherical_array(
        n_mics=n_mics,
        radius=radius,
        fs=fs,
        duration=0.01,
        source_points=source_points,
        sh_order_for_sm_calc=max(array_sh_order, asm_sh_order),
        convert_to_time=False,
    )
    array_sh_time = array.copy()
    array_sh_time.toTime()
    array_sh_time.toSH(array_sh_order)

    asm = ASM(
        sh_order=asm_sh_order,
        array=array,
        fs=fs,
        duration=0.01,
        spectrally_equalized=spectrally_equalized,
    )
    hrtf = _hrtf(fs=fs, sh_order=hrtf_sh_order)

    chain = ProcessorChain(
        [
            ArrayDecoder(array_sh_time),
            ASMEncoder(asm),
            BinauralDecoder(hrtf, sh_order=hrtf_sh_order,
                            output_format="SpatialSignal"),
        ]
    )
    return array, array_sh_time, asm, hrtf, chain


def _sequential_output(processors, signal):
    """Reference output obtained by applying each processor one at a time."""
    res = signal
    for processor in processors:
        res = processor.process(res)
    return res


# ---------------------------------------------------------------------------
# Main path
# ---------------------------------------------------------------------------

def test_chain_matches_sequential_processing(make_spherical_array):
    """Main path: chain output equals step-by-step processor application."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()

    chain_out = chain.process(signal)
    seq_out = _sequential_output(
        [
            ArrayDecoder(chain.processors[0].kernel),
            ASMEncoder(
                ASM(
                    sh_order=1,
                    array=chain.processors[1].kernel.array,
                    fs=16000,
                    duration=0.01,
                )
            ),
            BinauralDecoder(
                chain.processors[2].kernel, sh_order=1,
                output_format="SpatialSignal",
            ),
        ],
        signal,
    )

    T = min(chain_out.data.shape[2], seq_out.data.shape[2])
    np.testing.assert_allclose(
        chain_out.data[:, :, :T], seq_out.data[:, :, :T], atol=1e-6
    )


def test_repeated_calls_are_bit_identical_and_build_once(make_spherical_array):
    """Unchanged repeat calls reuse the cached kernel and return identical bits."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal(seed=3)

    first = chain.process(signal)
    assert chain.unified_kernel is not None
    cached_kernel = chain.unified_kernel

    calls = {"n": 0}
    original = chain.calculate_unified_kernel

    def counting_calculate(sig):
        calls["n"] += 1
        return original(sig)

    chain.calculate_unified_kernel = counting_calculate

    for k in range(5):
        again = chain.process(_amb_signal(seed=3))
        np.testing.assert_array_equal(again.data, first.data)
        assert again.data.dtype == first.data.dtype

    # No rebuild while the configuration and input layout stay the same.
    assert calls["n"] == 0
    assert chain.unified_kernel is cached_kernel


def test_different_time_length_reuses_same_kernel(make_spherical_array):
    """The kernel depends on layout/config, not on the signal's time length."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    chain.process(_amb_signal(n_samples=320))
    kernel = chain.unified_kernel

    chain.process(_amb_signal(n_samples=512))
    assert chain.unified_kernel is kernel


# ---------------------------------------------------------------------------
# Configuration change -> kernel recomputation, bit-identical to a fresh chain
# ---------------------------------------------------------------------------

def test_recompute_on_encoder_sh_order_change(make_spherical_array):
    """Changing the ASM encoder SH order forces a rebuild, matching a new chain."""
    _, array_sh_time, asm, hrtf, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal(sh_order=2)
    chain.process(signal)
    first_kernel = chain.unified_kernel

    # Replace the encoder with a higher SH order (upstream array supports it),
    # reusing the same physical array so a reference chain is bit-comparable.
    new_asm = ASM(
        sh_order=2, array=asm.array, fs=16000, duration=0.01
    )
    chain.processors[1] = ASMEncoder(new_asm)

    rebuilt = chain.process(signal)
    assert chain.unified_kernel is not first_kernel

    # A brand-new chain with the same configuration and component objects.
    reference_chain = ProcessorChain(
        [
            ArrayDecoder(array_sh_time),
            ASMEncoder(
                ASM(sh_order=2, array=asm.array, fs=16000, duration=0.01)
            ),
            BinauralDecoder(hrtf, sh_order=1, output_format="SpatialSignal"),
        ]
    )
    expected = reference_chain.process(signal)
    T = min(rebuilt.data.shape[2], expected.data.shape[2])
    np.testing.assert_array_equal(
        rebuilt.data[:, :, :T], expected.data[:, :, :T]
    )


def test_recompute_on_encoder_type_change(make_spherical_array):
    """Switching ASM -> SE-ASM (encoder type/coefficient change) rebuilds."""
    _, array_sh_time, asm, hrtf, chain = _build_chain_parts(
        make_spherical_array, spectrally_equalized=False
    )
    signal = _amb_signal()
    chain.process(signal)
    first_kernel = chain.unified_kernel

    se_asm = ASM(
        sh_order=1,
        array=asm.array,
        fs=16000,
        duration=0.01,
        spectrally_equalized=True,
    )
    chain.processors[1] = ASMEncoder(se_asm)

    rebuilt = chain.process(signal)
    assert chain.unified_kernel is not first_kernel

    # Reference: a fresh chain with SE-ASM over the same component objects.
    reference_chain = ProcessorChain(
        [
            ArrayDecoder(array_sh_time),
            ASMEncoder(
                ASM(
                    sh_order=1, array=asm.array, fs=16000, duration=0.01,
                    spectrally_equalized=True,
                )
            ),
            BinauralDecoder(hrtf, sh_order=1, output_format="SpatialSignal"),
        ]
    )
    expected = reference_chain.process(signal)
    T = min(rebuilt.data.shape[2], expected.data.shape[2])
    np.testing.assert_array_equal(
        rebuilt.data[:, :, :T], expected.data[:, :, :T]
    )


def _rebuild_reference_chain(processors):
    """
    Build a pristine reference chain with identical configuration to
    ``processors``, wrapping fresh processor objects around the same underlying
    kernel / encoder data. Re-wrapping the already-normalized processor
    instances themselves would double-flip their internal flags.
    """
    ref_processors = []
    for proc in processors:
        if isinstance(proc, ArrayDecoder):
            ref_processors.append(
                ArrayDecoder(proc.kernel, sh_order=proc.sh_order)
            )
        elif isinstance(proc, ASMEncoder):
            ref_processors.append(ASMEncoder(proc.kernel))
        elif isinstance(proc, BSMEncoder):
            ref_processors.append(BSMEncoder(proc.kernel))
        elif isinstance(proc, BinauralDecoder):
            ref_processors.append(
                BinauralDecoder(
                    proc.kernel,
                    sh_order=proc.sh_order,
                    output_format=proc._output_format
                    if proc._output_format != "SpatialSignal"
                    else "SpatialSignal",
                )
            )
        else:  # pragma: no cover - defensive
            ref_processors.append(proc)
    return ProcessorChain(ref_processors)


def test_recompute_on_array_geometry_change(make_spherical_array):
    """A different array geometry (mics / radius / source grid) invalidates cache."""
    _, _, _, _, chain = _build_chain_parts(
        make_spherical_array, n_mics=6, radius=0.1
    )
    signal = _amb_signal()
    chain.process(signal)
    first_kernel = chain.unified_kernel

    _, _, _, _, geometry_chain = _build_chain_parts(
        make_spherical_array, n_mics=8, radius=0.12
    )
    # Adopt the new processors; the chain re-normalizes their flags on rebuild,
    # exactly as a freshly constructed chain would.
    chain.processors = geometry_chain.processors

    rebuilt = chain.process(signal)
    assert chain.unified_kernel is not first_kernel

    # A pristine reference chain with the same configuration and kernel data.
    reference = _rebuild_reference_chain(geometry_chain.processors).process(signal)
    T = min(rebuilt.data.shape[2], reference.data.shape[2])
    np.testing.assert_array_equal(
        rebuilt.data[:, :, :T], reference.data[:, :, :T]
    )


def test_recompute_on_sampling_rate_change(make_spherical_array):
    """A different sampling rate across the chain forces a fresh kernel."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array, fs=16000)
    signal16k = _amb_signal(fs=16000)
    chain.process(signal16k)
    first_kernel = chain.unified_kernel

    _, _, _, _, fs_chain = _build_chain_parts(make_spherical_array, fs=8000)
    chain.processors = fs_chain.processors

    signal8k = _amb_signal(fs=8000)
    rebuilt = chain.process(signal8k)
    assert chain.unified_kernel is not first_kernel

    reference = _rebuild_reference_chain(fs_chain.processors).process(signal8k)
    T = min(rebuilt.data.shape[2], reference.data.shape[2])
    np.testing.assert_array_equal(
        rebuilt.data[:, :, :T], reference.data[:, :, :T]
    )


def test_inplace_array_mutation_invalidates_cache(make_spherical_array):
    """Mutating a kernel signal in place changes its fingerprint."""
    _, array_sh_time, _, _, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()
    chain.process(signal)
    first_sig = chain.config_signature()

    version_before = array_sh_time.mutation_version
    array_sh_time.toFreq()
    assert array_sh_time.mutation_version == version_before + 1
    assert chain.config_signature() != first_sig


def test_recompute_matches_brand_new_chain_bitwise(make_spherical_array):
    """After a change, output is bit-identical to a new chain of same processors."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()
    chain.process(signal)  # warm cache with the old configuration

    _, _, _, _, source_chain = _build_chain_parts(
        make_spherical_array, n_mics=8, radius=0.12
    )
    # Swap in the new processors on the already-warm chain.
    chain.processors = source_chain.processors
    rebuilt = chain.process(signal)

    # A pristine reference chain with the same configuration and kernel data.
    fresh_out = _rebuild_reference_chain(source_chain.processors).process(signal)
    T = min(rebuilt.data.shape[2], fresh_out.data.shape[2])
    np.testing.assert_array_equal(
        rebuilt.data[:, :, :T], fresh_out.data[:, :, :T]
    )


# ---------------------------------------------------------------------------
# Failure recovery: no half-built kernel / coefficients survive
# ---------------------------------------------------------------------------

def test_failure_on_frequency_domain_input_then_recovery(make_spherical_array):
    """A freq-domain input raises and leaves the chain clean for a retry."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    good_signal = _amb_signal()

    freq_signal = good_signal.copy()
    freq_signal.toFreq()
    assert freq_signal.is_freq

    with pytest.raises(ValueError):
        chain.process(freq_signal)

    # Clean state: nothing half-built was cached.
    assert chain.unified_kernel is None
    assert chain._build_signature is None
    assert chain._in_progress is None

    # Retry with a valid signal succeeds and matches a brand-new chain.
    recovered = chain.process(good_signal)
    _, _, _, _, fresh_chain = _build_chain_parts(make_spherical_array)
    expected = fresh_chain.process(good_signal)
    T = min(recovered.data.shape[2], expected.data.shape[2])
    np.testing.assert_array_equal(
        recovered.data[:, :, :T], expected.data[:, :, :T]
    )


def test_failure_on_mic_count_mismatch_then_recovery(make_spherical_array):
    """A microphone-count mismatch inside the chain raises and resets cache."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array, n_mics=6)
    good_signal = _amb_signal()

    # The impulse through ArrayDecoder yields 6 mics; build a chain whose ASM
    # expects 8 mics so the impulse build fails at the encoder assertion.
    _, _, mismatch_asm, _, mismatch_chain = _build_chain_parts(
        make_spherical_array, n_mics=8
    )
    chain.processors[1] = ASMEncoder(mismatch_asm)

    with pytest.raises(AssertionError):
        chain.process(good_signal)

    assert chain.unified_kernel is None
    assert chain._build_signature is None
    assert chain._in_progress is None

    # Restore a matching encoder and retry successfully.
    _, _, good_asm, _, _ = _build_chain_parts(make_spherical_array, n_mics=6)
    chain.processors[1] = ASMEncoder(good_asm)
    recovered = chain.process(good_signal)
    assert np.all(np.isfinite(recovered.data))


def test_failure_on_insufficient_sh_order_then_recovery(make_spherical_array):
    """An SH-order shortfall raises during the build and the chain recovers."""
    _, array_sh_time, asm, _, chain = _build_chain_parts(
        make_spherical_array, hrtf_sh_order=1
    )
    # HRTF capable of order 4; decoder demanding an order the order-1 impulse
    # signal cannot provide must fail at build time.
    hrtf4 = _hrtf(sh_order=4)
    chain.processors[2] = BinauralDecoder(
        hrtf4, sh_order=4, output_format="SpatialSignal"
    )

    with pytest.raises(ValueError):
        chain.process(_amb_signal(sh_order=1))

    assert chain.unified_kernel is None
    assert chain._build_signature is None
    assert chain._in_progress is None

    # A compatible decoder lets the next call succeed without any leftover state.
    chain.processors[2] = BinauralDecoder(
        hrtf4, sh_order=1, output_format="SpatialSignal"
    )
    out = chain.process(_amb_signal(sh_order=1))
    assert np.all(np.isfinite(out.data))

    # And the recovered chain still matches step-by-step processing bitwise.
    reference = ProcessorChain(
        [
            ArrayDecoder(array_sh_time),
            ASMEncoder(
                ASM(sh_order=1, array=asm.array, fs=16000, duration=0.01)
            ),
            BinauralDecoder(hrtf4, sh_order=1, output_format="SpatialSignal"),
        ]
    ).process(_amb_signal(sh_order=1))
    T = min(out.data.shape[2], reference.data.shape[2])
    np.testing.assert_array_equal(
        out.data[:, :, :T], reference.data[:, :, :T]
    )


def test_repeated_failures_keep_clean_state(make_spherical_array):
    """Several bad calls in a row never leave a partial kernel behind."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)

    bad_freq = _amb_signal()
    bad_freq.toFreq()
    for _ in range(3):
        with pytest.raises(ValueError):
            chain.process(bad_freq)
        assert chain.unified_kernel is None
        assert chain._in_progress is None

    out = chain.process(_amb_signal())
    assert chain.unified_kernel is not None
    assert np.all(np.isfinite(out.data))


class _FlakyASM(ASM):
    """ASM whose coefficient calculation fails once, then succeeds."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.attempts = 0

    def _compute_coefficients(self):
        self.attempts += 1
        if self.attempts == 1:
            raise RuntimeError("simulated coefficient build failure")
        return super()._compute_coefficients()


def test_asm_lazy_coefficients_failure_leaves_no_half_state(make_spherical_array):
    """A failed lazy ASM build keeps _cnm None; the next access rebuilds cleanly."""
    array = make_spherical_array(
        n_mics=6, radius=0.1, fs=16000, duration=0.01,
        source_points=50, sh_order_for_sm_calc=1, convert_to_time=False,
    )
    flaky = _FlakyASM(sh_order=1, array=array, fs=16000, duration=0.01)

    with pytest.raises(RuntimeError):
        _ = flaky.cnm
    assert flaky._cnm is None  # no half-built coefficients published

    cnm = flaky.cnm  # retry succeeds
    assert flaky._cnm is cnm
    assert np.all(np.isfinite(cnm.data))

    # A further access returns the same cached object (no rebuild).
    assert flaky.cnm is cnm
    assert flaky.attempts == 2


def test_asm_calculate_failure_is_atomic(make_spherical_array):
    """calculate() must not publish a partial result when it raises."""
    array = make_spherical_array(
        n_mics=6, radius=0.1, fs=16000, duration=0.01,
        source_points=50, sh_order_for_sm_calc=1, convert_to_time=False,
    )
    flaky = _FlakyASM(sh_order=1, array=array, fs=16000, duration=0.01)

    with pytest.raises(RuntimeError):
        flaky.calculate()
    assert flaky._cnm is None
    assert flaky.calculate() is flaky.cnm


# ---------------------------------------------------------------------------
# Concurrency: single first build, shared error, retry after failure
# ---------------------------------------------------------------------------

class _SlowChain(ProcessorChain):
    """Chain whose first kernel build blocks on an event (test-controlled)."""

    def __init__(
        self, processors, build_event, join_counter=None, expected_joins=0
    ):
        super().__init__(processors)
        self._build_event = build_event
        self._join_counter = join_counter
        self._expected_joins = expected_joins
        self.build_count = 0

    def calculate_unified_kernel(self, signal):
        self.build_count += 1
        if self._join_counter is not None:
            # Hold the build open until every other thread has joined.
            deadline = 0
            while (
                self._join_counter["joined"] < self._expected_joins
                and deadline < 200
            ):
                self._build_event.wait(timeout=0.05)
                deadline += 1
        self._build_event.wait(timeout=30)
        return super().calculate_unified_kernel(signal)


def test_concurrent_first_call_builds_kernel_once(make_spherical_array):
    """N threads calling process simultaneously share one complete kernel."""
    _, _, _, _, parts_chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()

    n_threads = 8
    build_event = threading.Event()
    join_counter = {"joined": 0}
    chain = _SlowChain(
        parts_chain.processors,
        build_event,
        join_counter=join_counter,
        expected_joins=n_threads - 1,
    )

    original_wait = chain._await_build

    def counting_wait(build):
        join_counter["joined"] += 1
        return original_wait(build)

    chain._await_build = counting_wait

    start = threading.Barrier(n_threads)
    outputs = [None] * n_threads
    errors = []

    def worker(i):
        start.wait()
        try:
            outputs[i] = chain.process(signal)
        except BaseException as exc:  # pragma: no cover - failure diagnostic
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()

    # Block until all non-builder threads have joined, then release the build.
    deadline = 0
    while join_counter["joined"] < n_threads - 1 and deadline < 200:
        deadline += 1
        build_event.wait(timeout=0.05)
    assert join_counter["joined"] == n_threads - 1
    build_event.set()

    for t in threads:
        t.join(timeout=30)
        assert not t.is_alive()

    assert errors == []
    assert chain.build_count == 1
    assert chain.unified_kernel is not None
    reference = chain.process(signal)
    for out in outputs:
        np.testing.assert_array_equal(out.data, reference.data)


class _FailingOnceChain(ProcessorChain):
    """Chain whose first build fails; every later build succeeds."""

    def __init__(self, processors, release_event=None, join_counter=None,
                 expected_joins=0):
        super().__init__(processors)
        self._release_event = release_event
        self._join_counter = join_counter
        self._expected_joins = expected_joins
        self.build_count = 0

    def calculate_unified_kernel(self, signal):
        self.build_count += 1
        if self.build_count == 1:
            if self._release_event is not None:
                # Block until every other thread has parked on the in-progress
                # build, so the failure is observed by all waiters at once.
                if self._join_counter is not None:
                    deadline = 0
                    while (
                        self._join_counter["joined"] < self._expected_joins
                        and deadline < 200
                    ):
                        self._release_event.wait(timeout=0.05)
                        deadline += 1
                self._release_event.wait(timeout=10)
            raise ValueError("simulated unified kernel build failure")
        return super().calculate_unified_kernel(signal)


def test_concurrent_failure_propagates_same_error_and_retry_succeeds(
    make_spherical_array,
):
    """All waiters of a failed concurrent build get the same error; retry works."""
    _, _, _, _, parts_chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()

    n_threads = 8
    release = threading.Event()
    join_counter = {"joined": 0}
    chain = _FailingOnceChain(
        parts_chain.processors,
        release_event=release,
        join_counter=join_counter,
        expected_joins=n_threads - 1,
    )

    # Track how many threads actually join the in-progress build.
    original_wait = chain._await_build

    def counting_wait(build):
        join_counter["joined"] += 1
        return original_wait(build)

    chain._await_build = counting_wait

    start = threading.Barrier(n_threads)
    errors = [None] * n_threads

    def worker(i):
        start.wait()
        try:
            chain.process(signal)
        except BaseException as exc:
            errors[i] = exc

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()

    # Wait until all non-builder threads have joined, then fail the build.
    deadline = 0
    while join_counter["joined"] < n_threads - 1 and deadline < 200:
        deadline += 1
        release.wait(timeout=0.05)
    assert join_counter["joined"] == n_threads - 1
    release.set()

    for t in threads:
        t.join(timeout=30)
        assert not t.is_alive()

    assert chain.build_count == 1
    # Every thread saw the exact same exception instance.
    assert all(isinstance(e, ValueError) for e in errors)
    assert all(e is errors[0] for e in errors)
    # Clean state after the shared failure.
    assert chain.unified_kernel is None
    assert chain._in_progress is None
    assert chain._build_signature is None

    # Retry succeeds and produces a finite result.
    out = chain.process(signal)
    assert chain.build_count == 2
    assert np.all(np.isfinite(out.data))
    assert chain.unified_kernel is not None


def test_concurrent_calls_after_cache_hit_need_no_rebuild(make_spherical_array):
    """Once built, concurrent calls all read the same published kernel."""
    _, _, _, _, chain = _build_chain_parts(make_spherical_array)
    signal = _amb_signal()
    chain.process(signal)
    kernel = chain.unified_kernel

    n_threads = 8
    start = threading.Barrier(n_threads)
    results = []

    def worker():
        start.wait()
        results.append(chain.process(signal).data)

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
        assert not t.is_alive()

    assert chain.unified_kernel is kernel
    assert len(results) == n_threads
    for data in results:
        np.testing.assert_array_equal(data, results[0])


# ---------------------------------------------------------------------------
# BSMEncoder chain: encoder-type swap changes the chain fingerprint
# ---------------------------------------------------------------------------

def test_bsm_encoder_signature_differs_from_asm(make_spherical_array):
    """Replacing an ASM encoder with a BSM encoder changes the chain signature."""
    _, _, asm, _, chain = _build_chain_parts(make_spherical_array)
    asm_sig = chain.config_signature()

    # Minimal synthetic BSM (full-rank synthetic steering matrix + HRTF).
    fs, n_fft, n_mics, q = 16000, 160, 6, 50
    rng = np.random.default_rng(11)
    from shroom.utils.grid_utils import from_fibonacci_grid  # noqa: E402

    grid = from_fibonacci_grid(q)
    v = rng.standard_normal((n_mics, q, n_fft)) + 1j * rng.standard_normal(
        (n_mics, q, n_fft)
    )
    h = rng.standard_normal((2, q, n_fft)) + 1j * rng.standard_normal(
        (2, q, n_fft)
    )
    array_mock = SpatialSignal(
        data=v, fs=fs, is_time=False, is_space=True, grid=grid
    )
    hrtf_mock = SpatialSignal(
        data=h, fs=fs, is_time=False, is_space=True, grid=grid
    )
    bsm = BSM(array=array_mock, hrtf=hrtf_mock, fs=fs)

    chain.processors[1] = BSMEncoder(bsm)
    new_sig = chain.config_signature()
    assert new_sig != asm_sig

    # The first tuple element of the changed processor identifies encoder type.
    assert new_sig[1][0] == "BSMEncoder"
    assert asm_sig[1][0] == "ASMEncoder"
