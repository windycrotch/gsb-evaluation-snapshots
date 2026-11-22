from abc import ABC, abstractmethod
from typing import List, Union
import threading
import numpy as np
from shroom.acoustics.spatial_signal import SpatialSignal
from shroom.encoders.asm import ASM
from shroom.encoders.bsm import BSM
from shroom.acoustics.spherical_array import SphericalArray
from shroom.utils.dsp_utils import convolve_and_sum



def stack_kernels_dynamically(kernel_list):
    """
    Helper to stack a list of kernels into a single array.
    Handles different input shapes (1, N) vs (N, 1).
    """
    # Get the shape of the first element to determine the stacking strategy
    first_shape = kernel_list[0].shape

    if first_shape[1] == 1:
        # Case A: (2, 1, 360) -> We want (2, 225, 360)
        # Squeeze out the singleton and stack on axis 1
        result = np.stack([k[:, 0, :] for k in kernel_list], axis=1)

    elif first_shape[0] == 1:
        # Case B: (1, 2, 360) -> We want (225, 2, 360)
        # Squeeze out the singleton and stack on axis 0
        result = np.stack([k[0, :, :] for k in kernel_list], axis=0)

    else:
        raise ValueError(f"Unexpected kernel shape: {first_shape}")

    return result


def _signal_signature(signal) -> tuple:
    """
    Hashable fingerprint of a SpatialSignal-like object.

    Captures identity, in-place mutation count, contents shape/dtype and the
    current domain, so that a cached kernel is invalidated when the signal is
    replaced, mutated in place, or converted between domains.
    """
    if signal is None:
        return (None,)
    return (
        type(signal).__name__,
        id(signal),
        getattr(signal, "mutation_version", None),
        tuple(signal.data.shape),
        str(signal.data.dtype),
        bool(getattr(signal, "is_time", True)),
        bool(getattr(signal, "is_space", False)),
        None if signal.grid is None else signal.grid.n_points,
    )


class AbstractProcessor(ABC):
    """Abstract base class for audio processors."""

    def __init__(self, kernel: SpatialSignal = None):
        self.kernel = kernel

    @abstractmethod
    def process(self, data):
        """Must be implemented by the subclass to handle audio processing."""
        pass

    def config_signature(self) -> tuple:
        """
        Hashable snapshot of the processor's key configuration.

        Two processors with equal signatures are guaranteed to produce equal
        outputs for equal inputs. ``ProcessorChain`` uses this to detect
        upstream configuration changes (sampling rate, SH order, array geometry
        or encoder type) and to rebuild its unified kernel accordingly.
        """
        kernel = self.kernel
        if hasattr(kernel, "config_signature"):
            # Encoder objects (ASM / BSM) carry their own fingerprint.
            kernel_sig = ("encoder", kernel.config_signature())
        else:
            kernel_sig = ("signal", _signal_signature(kernel))
        return (
            type(self).__name__,
            self.fs,
            getattr(self, "sh_order", None),
            kernel_sig,
        )

    @property
    def fs(self):
        return self.kernel.fs


# Upper bound on coordination rounds when waiters race against concurrent
# configuration changes. Each round either reuses a kernel, joins a build, or
# starts one; normal operation converges in a single round.
_MAX_BUILD_ROUNDS = 100


class ProcessorChain(AbstractProcessor):
    """
    Chains multiple processors together.
    The output of one processor is fed as input to the next.

    The chain collapses into a single unified kernel on the first
    :meth:`process` call. The cached kernel is rebuilt automatically whenever:

    * the input layout changes (a kernel built for a different signal shape
      would be invalid), or
    * the key configuration of any processor changes (sampling rate, SH order,
      array geometry, or encoder type), detected via
      :meth:`AbstractProcessor.config_signature`.

    All cache management is guarded by a lock. Concurrent first calls build the
    unified kernel exactly once: threads arriving while a build is in progress
    join that same build. A failed build publishes no partial kernel — every
    waiting thread receives the same exception, the chain is left in a clean
    state, and the next call retries from scratch.
    """

    def __init__(self, processors: List[AbstractProcessor]):
        """
        Initialize the chain.

        Parameters
        ----------
        processors : List[BaseProcessor]
            List of processors to execute in order.
        """
        self._validate_inputs(processors)
        self.processors = processors

        # Serializes kernel build/publish coordination across threads.
        self._lock = threading.RLock()
        self.unified_kernel = None
        # Build key (chain config + input layout) the cached kernel is valid for.
        self._build_signature = None
        # In-progress build joined by concurrent callers, or None when idle.
        self._in_progress = None

        if hasattr(processors[-1], "_output_format"):
            self._output_format = processors[-1]._output_format
            processors[-1]._output_format = "SpatialSignal"
        else:
            self._output_format = "SpatialSignal"

        if hasattr(processors[-1], "_enforce_real_values"):
            self._enforce_real_values = processors[-1]._enforce_real_values
            processors[-1]._enforce_real_values = False
        else:
            self._enforce_real_values = False

    def _prepare_last_processor(self):
        """
        Normalize the terminal processor for unified-kernel construction.

        The kernel must carry full complex precision; the chain takes the real
        part itself once, at the very end of :meth:`process`. This is applied
        in ``__init__`` for the original terminal processor and re-applied
        before every build so that a processor swapped in after construction
        behaves exactly as it would in a freshly built chain (bit-identical
        results), instead of silently truncating each impulse to real values.

        The chain-level flags are captured only from a still-pristine
        processor. An already-normalized processor (its flag already flipped
        to the chain-internal default) is left untouched so the captured
        original value is never overwritten.
        """
        last = self.processors[-1]
        if hasattr(last, "_output_format") and last._output_format != "SpatialSignal":
            self._output_format = last._output_format
            last._output_format = "SpatialSignal"
        if (
            hasattr(last, "_enforce_real_values")
            and last._enforce_real_values is not False
        ):
            self._enforce_real_values = last._enforce_real_values
            last._enforce_real_values = False

    @property
    def fs(self) -> int:
        return self.processors[0].fs

    def config_signature(self) -> tuple:
        """Fingerprint of the whole chain: changes when any processor's config does."""
        return tuple(p.config_signature() for p in self.processors)

    def _validate_inputs(self, processors):
        if not processors:
            raise ValueError("ProcessorChain must have at least one processor.")

        # validate all same fs
        fs_current = processors[0].fs
        for i, processor in enumerate(processors):
            if processor.fs != fs_current:
                raise ValueError(
                    f"All processors must have the same sampling frequency."
                    f"But, Processor ({processors[i - 1]}) has fs {fs_current}"
                    f"and Processor ({processor}) has fs {processor.fs}"
                )
            fs_current = processor.fs

    def _input_signature(self, signal: SpatialSignal) -> tuple:
        """
        Full build key: chain configuration plus the input layout the kernel
        must support. The kernel maps input channels/grid points one-to-one,
        so only the non-time axes participate: signals of any time length with
        the same channel/grid layout reuse one kernel.
        """
        return (
            self.config_signature(),
            tuple(signal.data.shape[:2]),
            str(signal.data.dtype),
            bool(signal.is_time),
            bool(signal.is_space),
            signal.fs,
            None if signal.grid is None else signal.grid.n_points,
        )

    def process(self, signal: SpatialSignal) -> Union[SpatialSignal, np.ndarray]:
        """Execute the chain, building or reusing the unified kernel as needed."""
        kernel = self._get_or_build_kernel(signal)

        # Apply kernel directly without SH-order truncation.
        # convolve_sh would truncate to min(kernel.sh_order, signal.sh_order), which
        # breaks chains where the signal is mic data (sh_order=0 due to shape[1]=1).
        sig1 = kernel.data if kernel.is_time else np.fft.ifft(kernel.data, axis=-1)
        sig2 = signal.data if signal.is_time else np.fft.ifft(signal.data, axis=-1)
        # convolve_and_sum sums over axis 1 (ch). Kernel has N_in on axis 1.
        # Mic-format signals have N_in on axis 0 → transpose to (1, N_in, T).
        if sig2.shape[1] == 1 and sig1.shape[1] != 1:
            sig2 = sig2.transpose(1, 0, 2)
        data = convolve_and_sum(sig1, sig2, "time", "time")

        if self._enforce_real_values:
            data = data.real

        if self._output_format == "numpy.ndarray":
            return data[:, 0, :].T
        result = SpatialSignal(
            data=data,
            fs=kernel.fs,
            is_time=kernel.is_time,
            is_space=kernel.is_space,
            grid=kernel.grid,
        )
        return result

    def _get_or_build_kernel(self, signal: SpatialSignal) -> SpatialSignal:
        """
        Return a kernel valid for ``signal``, building (or rebuilding) it once.

        Thread-safety contract:

        * a complete kernel is published to ``unified_kernel`` only after the
          full build succeeds — no thread can ever observe a half-built kernel;
        * concurrent callers with the same build key join one build; on
          failure every waiter raises the same exception instance;
        * a failed build clears all cached state, so the following call retries
          and can succeed.

        The loop also covers the rare case where a thread waits on a build that
        served a different build key: it simply re-evaluates and either reuses
        the cached kernel, joins another build, or starts its own.
        """
        signature = self._input_signature(signal)

        for _ in range(_MAX_BUILD_ROUNDS):
            with self._lock:
                # Fast path: a kernel already valid for this configuration.
                if (
                    self.unified_kernel is not None
                    and self._build_signature == signature
                ):
                    return self.unified_kernel

                if self._in_progress is None:
                    # Become the builder for a new build attempt.
                    build = {
                        "signature": signature,
                        "condition": threading.Condition(self._lock),
                        "done": False,
                        "error": None,
                    }
                    self._in_progress = build
                    is_builder = True
                else:
                    build = self._in_progress
                    is_builder = False

            if not is_builder:
                # Join the in-progress build (releases the lock while waiting).
                with self._lock:
                    self._await_build(build)
                    if build["error"] is not None:
                        # Every waiter of this build sees the same exception.
                        raise build["error"]
                # Build finished for (possibly) another key; loop to re-evaluate.
                continue

            # Builder path: build outside the chain lock so the underlying
            # processors' own locks are not nested inside it.
            try:
                # Re-normalize in case the terminal processor was replaced
                # after construction.
                self._prepare_last_processor()
                kernel = self.calculate_unified_kernel(signal)
            except BaseException as exc:
                with self._lock:
                    build["error"] = exc
                    build["done"] = True
                    # Clean state: no partial kernel is ever published.
                    self.unified_kernel = None
                    self._build_signature = None
                    self._in_progress = None
                    build["condition"].notify_all()
                raise

            with self._lock:
                # Publish atomically; only a fully built kernel is visible.
                self.unified_kernel = kernel
                self._build_signature = signature
                build["done"] = True
                self._in_progress = None
                build["condition"].notify_all()
                return kernel

        # pragma: no cover - defensive, requires pathological contention.
        raise RuntimeError(
            "ProcessorChain kernel coordination did not converge; retry process()."
        )

    def _await_build(self, build: dict):
        """Block on an in-progress build. Called with ``self._lock`` held.

        Isolated as a method so subscripts/tests can observe joiners without
        altering the coordination logic.
        """
        condition = build["condition"]
        while not build["done"]:
            condition.wait()

    def calculate_unified_kernel(self, signal) -> SpatialSignal:
        """Calculate unified kernel from signal."""
        C1, C2 = signal.data.shape[0], signal.data.shape[1]
        kernels = []

        if C1 != 1 and C2 != 1:
            raise ValueError(
                f"ProcessorChain expects input signal to be of shape (1, ?, ?) or (?, 1, ?) , and is of shape ({signal.data.shape})"
            )

        for c1 in range(C1):
            for c2 in range(C2):
                impulse = np.zeros((C1, C2, 1), dtype=signal.data.dtype)
                impulse[c1, c2, 0] = 1.0
                res = SpatialSignal(
                    data=impulse,
                    fs=signal.fs,
                    is_time=signal.is_time,
                    is_space=signal.is_space,
                    grid=signal.grid,
                )
                for processor in self.processors:
                    res = processor.process(res)
                kernels.append(res.data)
        kernels = stack_kernels_dynamically(kernels)
        return SpatialSignal(
            data=kernels,
            fs=signal.fs,
            is_time=signal.is_time,
            is_space=signal.is_space,
            grid=signal.grid,
        )


class BinauralDecoder(AbstractProcessor):
    """
    Decodes Ambisonics signal to Binaural (2-channel) audio using an HRTF.
    """

    def __init__(
        self,
        hrtf: SpatialSignal,
        sh_order: int = None,
        output_format: str = "numpy.ndarray",
    ):
        """
        Initialize BinauralDecoder.

        Parameters
        ----------
        hrtf : SpatialSignal
            The HRTF in SH domain.
        sh_order : int, optional
            The SH order to use for decoding. Defaults to min(hrtf.order, signal.order).
        output_format : str
            The output format. Default is 'numpy.ndarray' with shape (T, 2), another option is 'SpatialSignal'.
        """
        self._validate_inputs(hrtf, sh_order, output_format)
        self.kernel = hrtf
        self._fs = hrtf.fs
        self.sh_order = sh_order
        self._output_format = output_format
        self._enforce_real_values = True # enforce for format.

    def _validate_inputs(self, hrtf, sh_order, output_format):
        if not hrtf.is_time:
            raise ValueError("BinauralDecoder expects time domain input hrtf.")
        if not hrtf.is_sh:
            raise ValueError("BinauralDecoder expects SH domain input hrtf.")
        if sh_order is not None and not sh_order >= 0:
            raise ValueError("sh_order must be a non-negative integer.")
        if sh_order is not None and hrtf.sh_order < sh_order:
            raise ValueError("hrtf.sh_order must be >= sh_order.")
        if output_format not in ["numpy.ndarray", "SpatialSignal"]:
            raise ValueError(
                f"output_format must be 'numpy.ndarray' or 'SpatialSignal' and is ({output_format})"
            )

    def config_signature(self) -> tuple:
        return (
            "BinauralDecoder",
            self._fs,
            self.sh_order,
            _signal_signature(self.kernel),
        )

    def process(self, amb_signal: SpatialSignal) -> SpatialSignal:
        """
        Decode Ambisonics to Binaural.

        Parameters
        ----------
        amb_signal : SpatialSignal
            Input Ambisonics signal (SH domain).

        Returns
        -------
        SpatialSignal
            Binaural audio (2 channels).
        """
        if not amb_signal.is_sh:
            raise ValueError(
                "BinauralDecoder.process() expects SH domain input (Ambisonics)."
            )
        if self.sh_order is not None and self.sh_order > amb_signal.sh_order:
            raise ValueError(
                f"BinauralDecoder.process() expects sh order input ({amb_signal.sh_order}) >= convolove sh order ({self.sh_order})."
            )

        sh_order = int(
            self.sh_order
            if self.sh_order
            else np.min((amb_signal.sh_order, self.kernel.sh_order))
        )
        audio_data = self.kernel.convolve_sh(
            amb_signal, sh_order=sh_order, with_tilde=True
        )

        if self._enforce_real_values:
            audio_data = audio_data.real

        if self._output_format == 'numpy.ndarray':
            return audio_data[:, 0, :].T

        return SpatialSignal(
            data=audio_data,
            fs=self.fs,
            is_time=True,
            is_space=False,  # It's just channels (Audio)
            grid=None,
        )


class ArrayDecoder(AbstractProcessor):
    """
    Simulates the signals recorded by a spherical microphone array in a sound field.
    Input: Ambisonics (Sound Field).
    Output: Microphone Signals.
    """

    def __init__(self, array: SpatialSignal, sh_order: int = None):
        """
        Initialize ArrayDecoder.

        Parameters
        ----------
        array : SpatialSignal
            The array object defining the microphone positions and physics.
        sh_order : int, optional
            SH order to use for simulation.
        """
        self._validate_input(array, sh_order)
        self.kernel = array
        self.sh_order = sh_order

    def _validate_input(self, array, sh_order):
        if not array.is_time:
            raise ValueError("ArrayDecoder expects time domain input array.")
        if not array.is_sh:
            raise ValueError("ArrayDecoder expects SH domain input array.")
        if sh_order:
            if array.sh_order < sh_order:
                raise ValueError(
                    f"array.sh_order ({array.sh_order}) must be >= sh_order ({sh_order})."
                )

    def config_signature(self) -> tuple:
        # The array signal fingerprint tracks geometry (mic/source grids and
        # their point counts), SH order, fs and any in-place mutation.
        return (
            "ArrayDecoder",
            self.kernel.fs,
            self.sh_order,
            _signal_signature(self.kernel),
        )

    def process(self, amb_signal: SpatialSignal) -> SpatialSignal:
        """
        Simulate microphone signals.

        Parameters
        ----------
        amb_signal : SpatialSignal
            Input sound field in SH domain.

        Returns
        -------
        SpatialSignal
            Microphone signals.
        """

        if not amb_signal.is_time:
            raise ValueError(
                "ArrayDecoder expects time domain ambisonics input (Sound Field)."
            )

        # Operation: Project SH field onto microphones.

        sh_order = int(
            self.sh_order
            if self.sh_order
            else np.min((amb_signal.sh_order, self.kernel.sh_order))
        )
        mics_signal_data = self.kernel.convolve_sh(
            amb_signal, sh_order=sh_order, with_tilde=True
        )  # Projects to array's mic grid

        mics_signal = SpatialSignal(
            data=mics_signal_data,
            fs=amb_signal.fs,
            is_time=True,
            is_space=False,
            grid=None,  # We don't attach grid here to avoid shape mismatch if we use (M, 1, T)
        )
        return mics_signal


class ASMEncoder(AbstractProcessor):
    """
    Encodes microphone signals to Ambisonics using ASM (Ambisonics Signal Matching).
    Input: Microphone Signals.
    Output: Ambisonics (SH).
    """

    def __init__(self, asm_instance: ASM):
        """
        Initialize ASMEncoder.

        Parameters
        ----------
        asm_instance : ASM
            Configured ASM instance.
        """
        self.kernel = asm_instance
        # Ensure ASM coefficients are available. Accessing the lazy property
        # builds them atomically: a failure leaves _cnm as None, so the next
        # access retries instead of reusing a half-built coefficient set.
        _ = asm_instance.cnm

    def config_signature(self) -> tuple:
        # The ASM object's fingerprint covers sh order, fs, array geometry and
        # the (plain vs. spectrally-equalized) encoder type.
        return ("ASMEncoder", self.kernel.config_signature())

    def process(self, microphone_signal: SpatialSignal) -> SpatialSignal:
        """
        Encode microphone signals to Ambisonics.

        Parameters
        ----------
        microphone_signal : SpatialSignal
            Input microphone signals.

        Returns
        -------
        SpatialSignal
            Encoded Ambisonics signal.
        """
        # signal.data is (Mics, 1, Time)
        if not microphone_signal.is_time:
            raise ValueError(
                "ASMEncoder expects time domain input (Microphone Signals)."
            )

        microphone_signal_data = microphone_signal.data[:, 0, :].T  # (Time, Mics)
        encoded = self.kernel.encode_amb(microphone_signal_data)

        return encoded

class BSMEncoder(AbstractProcessor):
    """
    Encodes microphone signals directly to binaural audio using BSM (Beamformer-Steered Matching).
    Input: Microphone Signals.
    Output: Binaural (2-channel) audio.
    """

    def __init__(self, bsm_instance):
        """
        Initialize BSMEncoder.

        Parameters
        ----------
        bsm_instance : BSM
            Configured BSM instance.
        """
        self.kernel = bsm_instance

    @property
    def fs(self):
        return self.kernel.fs

    def config_signature(self) -> tuple:
        # Distinguishes a BSM encoder from any other encoder type and tracks
        # the BSM's own configuration (array, HRTF, regularization, MagLS).
        return ("BSMEncoder", self.kernel.config_signature())

    def process(self, microphone_signal: SpatialSignal) -> SpatialSignal:
        """
        Encode microphone signals to binaural audio.

        Parameters
        ----------
        microphone_signal : SpatialSignal
            Input microphone signals, shape (M, 1, T), is_time=True.

        Returns
        -------
        SpatialSignal
            Binaural audio, shape (2, 1, T), is_time=True, is_space=False.
        """
        if not microphone_signal.is_time:
            raise ValueError(
                "BSMEncoder expects time domain input (Microphone Signals)."
            )

        return self.kernel.process(microphone_signal)
