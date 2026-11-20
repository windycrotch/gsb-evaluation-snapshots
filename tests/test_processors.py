import threading
import time

import pytest
import numpy as np
from shroom.acoustics.processors import (
    ProcessorChain,
    ArrayDecoder,
    ASMEncoder,
    BinauralDecoder,
)
from shroom.acoustics.spatial_signal import SpatialSignal
from shroom.encoders.asm import ASM


@pytest.fixture
def mock_amb_signal():
    """Create a mock Ambisonics signal (SH domain)."""
    fs = 16000
    sh_order = 1
    n_sh = (sh_order + 1) ** 2
    n_samples = 1000

    # (SH, 1, Time)
    data = np.zeros((1, n_sh, n_samples))
    data[0, 0, 0] = 1.0  # Impulse in W channel

    return SpatialSignal(
        data=data, fs=fs, is_time=True, is_space=False, grid=None  # SH
    )


@pytest.fixture
def array_setup(make_spherical_array):
    """Create array and ASM instance."""
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
    """Create a mock HRTF in SH domain."""
    fs = 16000
    sh_order = 1
    n_sh = (sh_order + 1) ** 2
    n_ears = 2
    n_samples = 128

    data = np.zeros((n_ears, n_sh, n_samples))
    data[0, 0, 0] = 1.0  # Left ear W
    data[1, 0, 0] = 1.0  # Right ear W

    # SpatialSignal data is (Channels, Grid, Time); in the SH domain the middle axis
    # holds the SH coefficients and no grid object is needed.
    return SpatialSignal(
        data=data,
        fs=fs,
        is_time=True,
        is_space=False,
        grid=None,
    )


def test_processor_chain(mock_amb_signal, array_setup, mock_hrtf):
    """Test the full chain: Amb -> Array -> ASM -> Binaural."""
    array, asm = array_setup

    # 1. Define Processors
    array_decoder = ArrayDecoder(array)
    asm_encoder = ASMEncoder(asm)
    binaural_decoder = BinauralDecoder(
        mock_hrtf, sh_order=1, output_format="SpatialSignal"
    )

    # 2. Create Chain
    chain = ProcessorChain([array_decoder, asm_encoder, binaural_decoder])

    # 3. Process
    binaurals = chain.process(mock_amb_signal)

    # 4. Verify
    assert isinstance(binaurals, SpatialSignal)
    assert binaurals.is_time
    assert binaurals.is_space == False  # Binaural
    assert binaurals.data.shape[0] == 2  # Binaural
    assert binaurals.data.shape[1] == 1
    assert binaurals.data.shape[2] > 0


def test_processor_chain_numerical(mock_amb_signal, array_setup, mock_hrtf):
    """Chain output must match sequential processor application numerically."""
    array, asm = array_setup

    array_decoder = ArrayDecoder(array)
    asm_encoder = ASMEncoder(asm)
    binaural_decoder = BinauralDecoder(
        mock_hrtf, sh_order=1, output_format="SpatialSignal"
    )

    # Sequential processing
    mic_signals = array_decoder.process(mock_amb_signal)
    amb_encoded = asm_encoder.process(mic_signals)
    binaural_seq = binaural_decoder.process(amb_encoded)

    # Chain processing (fresh chain so unified kernel is computed from scratch)
    chain = ProcessorChain([
        ArrayDecoder(array),
        ASMEncoder(asm),
        BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal"),
    ])
    binaural_chain = chain.process(mock_amb_signal)

    # Trim to the shorter length to allow for edge differences
    T = min(binaural_seq.data.shape[2], binaural_chain.data.shape[2])
    seq_data = binaural_seq.data[:, :, :T].real
    chain_data = binaural_chain.data[:, :, :T].real

    np.testing.assert_allclose(chain_data, seq_data, atol=1e-6,
                               err_msg="ProcessorChain output differs from sequential processing")


# ---------------------------------------------------------------------------
# Unified-kernel cache: binding to the input, failure recovery, thread safety
# ---------------------------------------------------------------------------


def _make_amb_signal(fs=16000, n_samples=1000, sh_order=1, seed=0):
    """Ambisonics (SH, time domain) test signal with non-trivial content."""
    n_sh = (sh_order + 1) ** 2
    rng = np.random.default_rng(seed)
    data = rng.standard_normal((1, n_sh, n_samples)) * 1e-3
    data[0, 0, 0] = 1.0
    return SpatialSignal(data=data, fs=fs, is_time=True, is_space=False, grid=None)


def _make_chain(array, asm, hrtf, output_format="SpatialSignal", chain_cls=ProcessorChain):
    return chain_cls([
        ArrayDecoder(array),
        ASMEncoder(asm),
        BinauralDecoder(hrtf, sh_order=1, output_format=output_format),
    ])


def _sequential_reference(array, asm, hrtf, signal):
    """Run the processors one by one, directly."""
    mic = ArrayDecoder(array).process(signal)
    amb = ASMEncoder(asm).process(mic)
    return BinauralDecoder(hrtf, sh_order=1, output_format="SpatialSignal").process(amb)


def _assert_matches_sequential(chain_out, seq_out, atol=1e-6):
    T = min(chain_out.data.shape[2], seq_out.data.shape[2])
    np.testing.assert_allclose(
        chain_out.data[:, :, :T].real, seq_out.data[:, :, :T].real, atol=atol
    )


class CountingChain(ProcessorChain):
    """ProcessorChain that counts unified-kernel builds (and can slow them down)."""

    def __init__(self, processors, build_delay=0.0):
        super().__init__(processors)
        self.build_count = 0
        self._build_delay = build_delay

    def calculate_unified_kernel(self, signal):
        # Called under the chain's build lock, so the increment is serialized.
        self.build_count += 1
        if self._build_delay:
            time.sleep(self._build_delay)
        return super().calculate_unified_kernel(signal)


class FlakyProcessor:
    """Wraps a processor and raises on the first `failures_remaining` calls."""

    def __init__(self, inner, failures_remaining):
        self._inner = inner
        self.failures_remaining = failures_remaining

    @property
    def fs(self):
        return self._inner.fs

    def process(self, data):
        if self.failures_remaining > 0:
            self.failures_remaining -= 1
            raise RuntimeError("injected processor failure")
        return self._inner.process(data)


def test_chain_builds_kernel_only_once_per_input(array_setup, mock_hrtf):
    """Repeated calls with the same input signature reuse the cached kernel."""
    array, asm = array_setup
    signal = _make_amb_signal()
    chain = _make_chain(array, asm, mock_hrtf, chain_cls=CountingChain)

    out1 = chain.process(signal)
    out2 = chain.process(signal)
    out3 = chain.process(_make_amb_signal())  # equal signature, different object

    assert chain.build_count == 1
    np.testing.assert_array_equal(out1.data, out2.data)
    np.testing.assert_array_equal(out1.data, out3.data)


def test_chain_rebuilds_on_input_length_change(array_setup, mock_hrtf):
    """Changing the input length must rebuild the kernel, matching sequential."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf, chain_cls=CountingChain)

    chain.process(_make_amb_signal(n_samples=500))
    assert chain.build_count == 1

    longer = _make_amb_signal(n_samples=1500)
    out = chain.process(longer)
    assert chain.build_count == 2, "kernel must be rebuilt when input length changes"
    _assert_matches_sequential(out, _sequential_reference(array, asm, mock_hrtf, longer))


def test_chain_rebuilds_on_sh_order_change(array_setup, mock_hrtf):
    """Changing the input channel/SH dimension must rebuild the kernel."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf, chain_cls=CountingChain)

    chain.process(_make_amb_signal(sh_order=1))

    order2 = _make_amb_signal(sh_order=2)
    out = chain.process(order2)
    assert chain.build_count == 2, "kernel must be rebuilt when input shape changes"
    _assert_matches_sequential(out, _sequential_reference(array, asm, mock_hrtf, order2))


def test_chain_rebuilds_on_fs_change(array_setup, mock_hrtf):
    """Changing the input sampling rate must rebuild the kernel."""
    array, asm = array_setup
    chain = _make_chain(array, asm, mock_hrtf, chain_cls=CountingChain)

    chain.process(_make_amb_signal(fs=16000))

    new_fs = 8000
    signal_new_fs = _make_amb_signal(fs=new_fs)
    out = chain.process(signal_new_fs)
    assert chain.build_count == 2, "kernel must be rebuilt when fs changes"
    assert out.fs == new_fs, "output must carry the new sampling rate, not the stale one"
    _assert_matches_sequential(out, _sequential_reference(array, asm, mock_hrtf, signal_new_fs))


def test_chain_rebuilds_on_domain_change(mock_hrtf):
    """Switching the input between time and frequency domain must rebuild the kernel."""
    # BinauralDecoder accepts both time and frequency domain SH input, unlike
    # ArrayDecoder, so use a single-processor chain for the domain switch.
    chain = CountingChain([BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal")])

    time_signal = _make_amb_signal()
    out_time = chain.process(time_signal)
    assert chain.build_count == 1
    # Time-domain result matches calling the decoder directly.
    direct = BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal").process(time_signal)
    _assert_matches_sequential(out_time, direct)

    freq_signal = _make_amb_signal()
    freq_signal.toFreq()
    out_freq = chain.process(freq_signal)
    assert chain.build_count == 2, "kernel must be rebuilt when time/freq domain changes"

    # The rebuilt result must equal what a fresh chain computes for this input.
    fresh = CountingChain([BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal")])
    out_fresh = fresh.process(freq_signal)
    np.testing.assert_allclose(out_freq.data, out_fresh.data, atol=1e-12)

    # Switching back to the time domain rebuilds again and still matches direct.
    out_time2 = chain.process(time_signal)
    assert chain.build_count == 3
    _assert_matches_sequential(out_time2, direct)


def test_chain_failure_leaves_clean_state(array_setup, mock_hrtf):
    """A processor raising during the build must not corrupt the chain."""
    array, asm = array_setup
    signal = _make_amb_signal()

    binaural_decoder = BinauralDecoder(mock_hrtf, sh_order=1, output_format="numpy.ndarray")
    flaky = FlakyProcessor(ArrayDecoder(array), failures_remaining=1)
    chain = ProcessorChain([flaky, ASMEncoder(asm), binaural_decoder])

    with pytest.raises(RuntimeError, match="injected processor failure"):
        chain.process(signal)

    # No half-built kernel may remain.
    assert chain.unified_kernel is None
    # The last processor's configuration must not be stuck in the intermediate
    # state used during kernel construction.
    assert binaural_decoder._output_format == "numpy.ndarray"
    assert binaural_decoder._enforce_real_values is True

    # Retry succeeds and matches sequential processing.
    out = chain.process(signal)
    assert isinstance(out, np.ndarray)  # chain honors the decoder's output format
    seq = _sequential_reference(array, asm, mock_hrtf, signal)
    T = min(out.shape[0], seq.data.shape[2])
    np.testing.assert_allclose(out[:T].T, seq.data[:, 0, :T].real, atol=1e-6)
    # Flags still intact after a successful build.
    assert binaural_decoder._output_format == "numpy.ndarray"
    assert binaural_decoder._enforce_real_values is True


def test_chain_failed_rebuild_preserves_previous_cache(array_setup, mock_hrtf):
    """A failed rebuild for a new input must not destroy the existing cached kernel."""
    array, asm = array_setup
    signal_a = _make_amb_signal(n_samples=500)

    binaural_decoder = BinauralDecoder(mock_hrtf, sh_order=1, output_format="SpatialSignal")
    flaky = FlakyProcessor(ArrayDecoder(array), failures_remaining=0)
    chain = CountingChain([flaky, ASMEncoder(asm), binaural_decoder])

    out_a = chain.process(signal_a)
    assert chain.build_count == 1

    # Rebuild for a new input signature fails.
    flaky.failures_remaining = 1
    signal_b = _make_amb_signal(n_samples=900)
    with pytest.raises(RuntimeError, match="injected processor failure"):
        chain.process(signal_b)
    assert chain.build_count == 2

    # The previously cached input still works without a rebuild.
    out_a2 = chain.process(signal_a)
    assert chain.build_count == 2
    np.testing.assert_array_equal(out_a.data, out_a2.data)

    # And the failed input now builds cleanly and matches sequential.
    out_b = chain.process(signal_b)
    assert chain.build_count == 3
    _assert_matches_sequential(out_b, _sequential_reference(array, asm, mock_hrtf, signal_b))


def test_chain_concurrent_first_call(array_setup, mock_hrtf):
    """Concurrent first calls must build the kernel exactly once and agree."""
    array, asm = array_setup
    signal = _make_amb_signal()
    # Slow the build down so both threads are inside `process` concurrently.
    chain = _make_chain(array, asm, mock_hrtf, chain_cls=CountingChain)
    chain._build_delay = 0.2

    barrier = threading.Barrier(2)
    results, errors = {}, {}

    def worker(idx):
        try:
            barrier.wait(timeout=10)
            results[idx] = chain.process(signal)
        except Exception as exc:  # pragma: no cover - failure path
            errors[idx] = exc

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert not errors, f"concurrent calls raised: {errors}"
    assert chain.build_count == 1, "kernel must be built exactly once"
    np.testing.assert_array_equal(results[0].data, results[1].data)
    _assert_matches_sequential(results[0], _sequential_reference(array, asm, mock_hrtf, signal))
