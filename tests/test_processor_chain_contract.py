"""Tests for the ProcessorChain unified-kernel contract, rebuild and rollback.

The chain folds its processors into a single convolution kernel and caches it.
These tests pin down that the cache is bound to the input contract (shape, rate,
domain, grid), that a failed rebuild rolls back while keeping the previous kernel
usable, that sampling-rate drift is refused, and that concurrent callers using
different contracts do not pollute each other's cache.
"""

import threading

import numpy as np
import pytest

from shroom.acoustics.processors import (
    ProcessorChain,
    ArrayDecoder,
    ASMEncoder,
    BinauralDecoder,
    BSMEncoder,
    ChainFailure,
    ChainKernelBuildError,
    ChainSamplingRateError,
    _contract_key,
)
from shroom.acoustics.spatial_signal import SpatialSignal
from shroom.encoders.asm import ASM
from shroom.encoders.bsm import BSM
from shroom.geometry.sampling import sphereicalGrid
from shroom.utils.grid_utils import from_fibonacci_grid


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def array_setup(make_spherical_array):
    """Array time+SH steering matrix and a matching ASM encoder."""
    fs = 16000
    array = make_spherical_array(
        n_mics=6,
        radius=0.1,
        fs=fs,
        duration=0.01,
        source_points=50,
        sh_order_for_sm_calc=1,
        convert_to_time=False,
    )
    array_sh_time = array.copy()
    array_sh_time.toTime()
    array_sh_time.toSH(1)
    asm = ASM(sh_order=1, array=array, fs=fs, duration=0.01)
    return array_sh_time, asm


@pytest.fixture
def mock_hrtf():
    """Minimal SH-domain HRTF (2 ears, order 1)."""
    fs = 16000
    data = np.zeros((2, 4, 128))
    data[0, 0, 0] = 1.0
    data[1, 0, 0] = 1.0
    return SpatialSignal(data=data, fs=fs, is_time=True, is_space=False, grid=None)


def _make_chain(array, asm, hrtf, output_format="SpatialSignal"):
    """Array -> ASM -> Binaural chain used by the contract tests."""
    return ProcessorChain(
        [
            ArrayDecoder(array),
            ASMEncoder(asm),
            BinauralDecoder(hrtf, sh_order=1, output_format=output_format),
        ]
    )


def _make_signal(n_samples, fs, sh_order=1):
    """Deterministic SH input (1, n_sh, T) with a non-trivial spectrum."""
    rng = np.random.default_rng(1234)
    n_sh = (sh_order + 1) ** 2
    return SpatialSignal(
        data=rng.standard_normal((1, n_sh, n_samples)),
        fs=fs,
        is_time=True,
        is_space=False,
    )


def _sequential(processors, signal):
    res = signal
    for processor in processors:
        res = processor.process(res)
    return res


def _assert_matches_sequential(out, seq, atol=1e-6, msg=""):
    T = min(seq.data.shape[-1], out.data.shape[-1])
    np.testing.assert_allclose(out.data[:, :, :T], seq.data[:, :, :T], atol=atol, err_msg=msg)


# ---------------------------------------------------------------------------
# Normal rebuild + contract invalidation
# ---------------------------------------------------------------------------


def test_normal_rebuild_is_deterministic(array_setup, mock_hrtf):
    """The first process folds the chain; processing again reuses the same kernel."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)

    sig = _make_signal(400, fs=16000)
    out1 = chain.process(sig)
    kernel1 = chain.unified_kernel
    out2 = chain.process(sig.copy())

    assert chain.unified_kernel is kernel1  # same contract -> cache hit
    np.testing.assert_array_equal(out1.data, out2.data)
    _assert_matches_sequential(out1, _sequential(chain.processors, sig), msg="folded kernel")


def test_rebuild_on_input_length_change(array_setup, mock_hrtf):
    """A new input length invalidates the cached kernel and rebuilds it."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)

    long_signal = _make_signal(800, fs=16000)
    short_signal = _make_signal(400, fs=16000)

    out_long = chain.process(long_signal)
    kernel_long = chain.unified_kernel
    out_short = chain.process(short_signal)

    assert chain.unified_kernel is not kernel_long

    for sig, out in ((long_signal, out_long), (short_signal, out_short)):
        _assert_matches_sequential(
            out,
            _sequential(chain.processors, sig),
            msg="Rebuilt kernel disagrees with sequential processing",
        )


def test_contract_key_binds_shape_rate_domain_and_grid():
    """The contract key encodes shape, fs, time/freq domain and SH/space domain."""
    sig = _make_signal(600, fs=16000)
    base = _contract_key(sig)

    assert _contract_key(sig.copy()) == base  # same contract
    assert _contract_key(_make_signal(601, fs=16000)) != base  # different length
    assert _contract_key(_make_signal(600, fs=48000)) != base  # different fs

    freq = sig.copy()
    freq.toFreq()
    assert _contract_key(freq) != base  # different domain

    space = sig.copy()
    grid = sphereicalGrid(
        az=np.linspace(0, 2 * np.pi, 8, endpoint=False),
        co=np.full(8, np.pi / 2),
    )
    space.toSpace(grid)
    assert space.is_space
    assert _contract_key(space) != base  # different space/SH contract

    # A different grid with the same number of points is a different contract.
    other_grid = sphereicalGrid(
        az=np.linspace(0.1, 2 * np.pi + 0.1, 8, endpoint=False),
        co=np.full(8, np.pi / 2),
    )
    space2 = sig.copy()
    space2.toSpace(other_grid)
    assert _contract_key(space2) != _contract_key(space)


def test_rebuild_on_domain_change():
    """A different domain contract invalidates and rebuilds the cached kernel."""
    class PassThrough:
        fs = 16000

        def process(self, signal):
            return signal

    chain = ProcessorChain([PassThrough()])

    sig_time = _make_signal(500, fs=16000)
    chain.process(sig_time)
    kernel_time = chain.unified_kernel

    # Same shape and rate, but frequency domain: a different contract.
    sig_freq = sig_time.copy()
    sig_freq.toFreq()
    assert sig_freq.is_freq
    chain.process(sig_freq)
    assert chain.unified_kernel is not kernel_time


# ---------------------------------------------------------------------------
# Failure rollback
# ---------------------------------------------------------------------------


class _FailingProcessor:
    """Identity processor that can be told to raise during folding."""

    fs = 16000

    def __init__(self):
        self.fail = False

    def process(self, signal):
        if self.fail:
            raise RuntimeError("boom in processor")
        return signal

    def __repr__(self):
        return "FailingProcessor()"


def test_failure_rollback_keeps_previous_kernel_usable(array_setup):
    """A failed rebuild keeps the old kernel usable and exposes failure info."""
    array, asm = array_setup
    flaky = _FailingProcessor()

    chain = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm), flaky])

    short_signal = _make_signal(50, fs=16000)
    chain.process(short_signal)
    cached_kernel = chain.unified_kernel
    assert cached_kernel is not None
    assert chain.failure is None

    # A longer input needs a rebuild, which fails at processor index 2.
    flaky.fail = True
    bad_signal = _make_signal(300, fs=16000)
    with pytest.raises(ChainKernelBuildError) as excinfo:
        chain.process(bad_signal)

    err = excinfo.value
    assert isinstance(err, RuntimeError)  # original exception type preserved
    assert err.processor_index == 2
    assert isinstance(err.exception, RuntimeError)
    assert "boom in processor" in str(err)

    failure = chain.failure
    assert isinstance(failure, ChainFailure)
    assert failure.processor_index == 2
    assert isinstance(failure.exception, RuntimeError)
    assert chain.unified_kernel is cached_kernel  # old kernel retained

    # Old-contract input still processes correctly (cache hit skips the folding,
    # so the failing stage is never invoked) and does not rebuild.
    out_again = chain.process(short_signal)
    assert chain.unified_kernel is cached_kernel
    ref_chain = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm)])
    ref_out = ref_chain.process(short_signal)
    np.testing.assert_allclose(out_again.data, ref_out.data, atol=1e-6)


def test_successful_rebuild_clears_failure(array_setup):
    """Info about a failed rebuild is cleared by the next successful rebuild."""
    array, asm = array_setup
    flaky = _FailingProcessor()

    chain = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm), flaky])
    chain.process(_make_signal(50, fs=16000))

    flaky.fail = True
    with pytest.raises(ChainKernelBuildError):
        chain.process(_make_signal(300, fs=16000))
    assert chain.failure is not None

    # A contract that can be folded succeeds and clears the failure record.
    flaky.fail = False
    chain.process(_make_signal(40, fs=16000))
    assert chain.failure is None


def test_failure_from_first_build_reports_processor_index(array_setup, mock_hrtf):
    """If the very first build fails there is no kernel, but failure is reported."""
    array, asm = array_setup
    flaky = _FailingProcessor()
    flaky.fail = True
    chain = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm), flaky])
    with pytest.raises(ChainKernelBuildError) as excinfo:
        chain.process(_make_signal(100, fs=16000))
    assert excinfo.value.processor_index == 2
    assert chain.unified_kernel is None
    assert chain.failure is not None


# ---------------------------------------------------------------------------
# Sampling-rate drift
# ---------------------------------------------------------------------------


def test_sampling_rate_drift_is_rejected_with_index(array_setup, mock_hrtf):
    """Changing a processor's fs after construction is refused before processing."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)

    sig = _make_signal(400, fs=16000)
    chain.process(sig)  # establish a working kernel

    chain.processors[1].kernel.fs = 8000  # simulate external mutation

    with pytest.raises(ChainSamplingRateError) as excinfo:
        chain.process(sig)
    message = str(excinfo.value)
    assert "index 1" in message, message
    assert "16000" in message and "8000" in message, message


def test_sampling_rate_drift_reports_correct_stage(array_setup, mock_hrtf):
    """The reported processor index identifies the stage that drifted."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)
    chain.processors[2].kernel.fs = 44100

    with pytest.raises(ChainSamplingRateError) as excinfo:
        chain.process(_make_signal(100, fs=16000))
    assert "index 2" in str(excinfo.value)


def test_sampling_rate_drift_detected_before_cache_lookup(array_setup, mock_hrtf):
    """Even a cache hit must not bypass the sampling-rate guard."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)
    sig = _make_signal(200, fs=16000)
    chain.process(sig)

    # Mutate the source array's fs; the ArrayDecoder resolves fs from its kernel.
    chain.processors[0].kernel.fs = 8000
    with pytest.raises(ChainSamplingRateError):
        chain.process(sig.copy())


# ---------------------------------------------------------------------------
# Input formats
# ---------------------------------------------------------------------------


def test_sh_format_input_enters_folded_path(array_setup, mock_hrtf):
    """SH input (first dim == 1) folds and matches sequential processing."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)

    sig = _make_signal(300, fs=16000)
    assert sig.data.shape[0] == 1
    out = chain.process(sig)
    _assert_matches_sequential(out, _sequential(chain.processors, sig))


def test_mic_format_input_enters_folded_path(array_setup, mock_hrtf):
    """Mic-format input (second dim == 1) enters the folded path correctly."""
    array, asm = array_setup

    rng = np.random.default_rng(7)
    n_mics = array.data.shape[0]
    mic = SpatialSignal(
        data=rng.standard_normal((n_mics, 1, 250)),
        fs=16000,
        is_time=True,
        is_space=False,
    )
    assert mic.data.shape[1] == 1

    chain = ProcessorChain(
        [
            ASMEncoder(asm),
            BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal"),
        ]
    )
    out = chain.process(mic)
    _assert_matches_sequential(
        out,
        _sequential(chain.processors, mic),
        msg="Mic-format folded chain differs from sequential",
    )


def test_chain_output_format_matches_last_stage(array_setup, mock_hrtf):
    """Chain honours the last processor's declared output format."""
    array, asm = array_setup

    nd = BinauralDecoder(mock_hrtf, sh_order=1, output_format="numpy.ndarray")
    chain = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm), nd])
    out = chain.process(_make_signal(300, fs=16000))
    assert isinstance(out, np.ndarray)
    assert out.ndim == 2 and out.shape[1] == 2

    ss = BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal")
    chain2 = ProcessorChain([ArrayDecoder(array), ASMEncoder(asm), ss])
    out2 = chain2.process(_make_signal(300, fs=16000))
    assert isinstance(out2, SpatialSignal)
    assert out2.data.shape[0] == 2
    assert out2.is_time and not out2.is_space


def test_truncating_final_stage_folds_exactly():
    """A truncating final stage (BSMEncoder) folds to the sequential output."""
    fs = 8000
    n_fft, Q, M = 80, 50, 5
    grid = from_fibonacci_grid(Q)
    rng = np.random.default_rng(42)
    V = rng.standard_normal((M, Q, n_fft)) + 1j * rng.standard_normal((M, Q, n_fft))
    H = rng.standard_normal((2, Q, n_fft)) + 1j * rng.standard_normal((2, Q, n_fft))
    array = SpatialSignal(data=V, fs=fs, is_time=False, is_space=True, grid=grid)
    hrtf = SpatialSignal(data=H, fs=fs, is_time=False, is_space=True, grid=grid)
    bsm = BSM(array=array, hrtf=hrtf, use_magls=False, fs=fs)

    array_sh = array.copy()
    array_sh.toTime()
    array_sh.toSH(1)

    ad = ArrayDecoder(array_sh)
    be = BSMEncoder(bsm)
    chain = ProcessorChain([ArrayDecoder(array_sh), BSMEncoder(bsm)])

    sig = SpatialSignal(
        data=rng.standard_normal((1, 4, 400)), fs=fs, is_time=True, is_space=False
    )
    out = chain.process(sig)
    seq = be.process(ad.process(sig))
    assert out.data.shape == seq.data.shape
    np.testing.assert_allclose(
        out.data, seq.data, atol=1e-6,
        err_msg="BSM folded chain differs from sequential",
    )


def test_non_final_truncating_stage_is_rejected():
    """A truncating stage that is not last cannot be folded, so construction fails."""
    fs = 8000
    n_fft, Q, M = 80, 50, 5
    grid = from_fibonacci_grid(Q)
    rng = np.random.default_rng(42)
    V = rng.standard_normal((M, Q, n_fft)) + 1j * rng.standard_normal((M, Q, n_fft))
    H = rng.standard_normal((2, Q, n_fft)) + 1j * rng.standard_normal((2, Q, n_fft))
    array = SpatialSignal(data=V, fs=fs, is_time=False, is_space=True, grid=grid)
    hrtf = SpatialSignal(data=H, fs=fs, is_time=False, is_space=True, grid=grid)
    bsm = BSM(array=array, hrtf=hrtf, use_magls=False, fs=fs)

    with pytest.raises(ValueError, match="truncates its output"):
        ProcessorChain([BSMEncoder(bsm), BSMEncoder(bsm)])


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_concurrent_contracts_do_not_pollute_cache(array_setup, mock_hrtf):
    """Two threads using different contracts each get correct, independent results."""
    array, asm = array_setup

    chain = _make_chain(array, asm, mock_hrtf)
    sig_long = _make_signal(600, fs=16000)
    sig_short = _make_signal(200, fs=16000)

    results = {}
    errors = []

    def run(name, signal):
        try:
            results[name] = chain.process(signal)
        except Exception as exc:  # pragma: no cover - failure path
            errors.append((name, exc))

    t1 = threading.Thread(target=run, args=("long", sig_long))
    t2 = threading.Thread(target=run, args=("short", sig_short))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert not errors, errors

    for name, sig in (("long", sig_long), ("short", sig_short)):
        _assert_matches_sequential(
            results[name],
            _sequential(chain.processors, sig),
            msg=f"Concurrent result for '{name}' is wrong (cache pollution)",
        )

    # Both contracts remain cached so neither thread's kernel was evicted.
    assert _contract_key(sig_long) in chain._kernel_cache
    assert _contract_key(sig_short) in chain._kernel_cache


def test_concurrent_same_contract_reuses_single_kernel(array_setup, mock_hrtf):
    """Threads sharing one contract all receive the same cached-kernel result."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf)

    sig = _make_signal(300, fs=16000)
    outputs = []
    errors = []
    barrier = threading.Barrier(4)

    def run():
        try:
            barrier.wait(timeout=10)
            outputs.append(chain.process(sig.copy()))
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, errors
    assert len(outputs) == 4
    for out in outputs[1:]:
        np.testing.assert_array_equal(outputs[0].data, out.data)

    # Only one contract cached -> exactly one kernel build.
    assert len(chain._kernel_cache) == 1
