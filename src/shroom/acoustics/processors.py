from abc import ABC, abstractmethod
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple, Union
import numpy as np
from shroom.acoustics.spatial_signal import SpatialSignal
from shroom.encoders.asm import ASM
from shroom.encoders.bsm import BSM
from shroom.acoustics.spherical_array import SphericalArray
from shroom.utils.dsp_utils import convolve_and_sum


# Guards the temporary overrides applied to the last processor while an impulse
# response is being measured.  It is module level (rather than per chain) because
# the same processor instance may be shared by several chains.
_PROCESSOR_OVERRIDE_LOCK = threading.RLock()

# Bump when the meaning of a cached-kernel contract changes.
_CONTRACT_VERSION = 1


def stack_kernels_dynamically(kernel_list):
    """
    Helper to stack a list of kernels into a single array.

    Each element of ``kernel_list`` is the impulse response obtained by feeding a
    single unit impulse through the chain, i.e. it carries a singleton on the
    input-channel axis.  Both layouts are supported:

    * ``(N_out, 1, T)`` -> ``(N_out, N_in, T)``  (stack on axis 1)
    * ``(1, N_out, T)`` -> ``(N_in, N_out, T)``  (stack on axis 0)
    """
    if not kernel_list:
        raise ValueError("stack_kernels_dynamically requires at least one kernel.")

    shapes = {k.shape for k in kernel_list}
    if len(shapes) != 1:
        raise ValueError(
            f"All impulse responses must have the same shape, got: {sorted(shapes)}"
        )

    first_shape = kernel_list[0].shape
    if len(first_shape) != 3:
        raise ValueError(f"Kernels must be 3-D arrays, got shape: {first_shape}")

    if first_shape[1] == 1:
        # Case A: (2, 1, 360) -> We want (2, 225, 360)
        # Squeeze out the singleton and stack on axis 1
        result = np.stack([k[:, 0, :] for k in kernel_list], axis=1)

    elif first_shape[0] == 1:
        # Case B: (1, 2, 360) -> We want (225, 2, 360)
        # Squeeze out the singleton and stack on axis 0
        result = np.stack([k[0, :, :] for k in kernel_list], axis=0)

    else:
        raise ValueError(
            f"Unexpected kernel shape: {first_shape}. Expected a singleton on the "
            f"input-channel axis, i.e. (N, 1, T) or (1, N, T)."
        )

    return result


def _array_signature(array: Optional[np.ndarray]):
    """Stable, content-based signature for an array (used in contract keys)."""
    if array is None:
        return None
    array = np.ascontiguousarray(array)
    digest = hashlib.blake2b(array.tobytes(), digest_size=16).hexdigest()
    return (array.dtype.str, array.shape, digest)


def _grid_signature(grid) -> Optional[tuple]:
    """Content-based signature of a sampling grid's contract."""
    if grid is None:
        return None
    return (
        getattr(grid, "n_points", None),
        getattr(grid, "sh_type", None),
        _array_signature(getattr(grid, "az", None)),
        _array_signature(getattr(grid, "co", None)),
        _array_signature(getattr(grid, "weights", None)),
        _array_signature(getattr(grid, "orientation", None)),
    )


def _contract_key(signal: SpatialSignal) -> tuple:
    """
    Identify the input contract a cached unified kernel is valid for.

    The folded kernel depends on the *shape* of the input (which channel axis is
    being summed), the sampling rate, the time/frequency domain, the SH/space
    domain and the sampling grid.  Any change to those must invalidate the cache.
    """
    data = signal.data
    return (
        _CONTRACT_VERSION,
        tuple(data.shape),
        data.dtype.str,
        float(signal.fs),
        bool(signal.is_time),
        bool(signal.is_space),
        _grid_signature(signal.grid),
    )


class _KernelBuildFailure(Exception):
    """Internal wrapper carrying the index of the processor that failed."""

    def __init__(self, processor_index: Optional[int], processor, exception: BaseException):
        self.processor_index = processor_index
        self.processor = processor
        self.exception = exception
        super().__init__(str(exception))


@dataclass(frozen=True)
class ChainFailure:
    """
    Queryable description of the last failed unified-kernel build.

    Attributes
    ----------
    processor_index : int or None
        Index (in ``ProcessorChain.processors``) of the processor that raised.
        ``None`` if the failure happened outside a processor (e.g. while
        stacking the impulse responses).
    processor : object or None
        The processor instance that raised.
    exception : BaseException
        The original exception raised while folding the chain.
    contract : tuple or None
        Internal contract key of the input that triggered the rebuild.
    """

    processor_index: Optional[int]
    processor: Optional[Any]
    exception: BaseException
    contract: Optional[tuple] = None

    def __str__(self) -> str:
        if self.processor_index is None:
            where = "kernel stacking"
        else:
            where = f"processor index {self.processor_index} ({self.processor!r})"
        return (
            f"unified kernel build failed in {where}: "
            f"{type(self.exception).__name__}: {self.exception}"
        )


class ChainKernelBuildError(RuntimeError):
    """
    Raised by :meth:`ProcessorChain.process` when a unified kernel has to be
    rebuilt for a new input contract and the rebuild fails.

    The chain keeps its previously built kernel(s) usable for their own input
    contracts.  Details of the failure are available through ``failure`` (and
    through ``chain.failure``).

    To keep backwards compatibility with callers that catch the processor's own
    exception type, the raised instance also derives from the original exception
    class when that is possible (see :func:`_as_chain_error`).
    """

    def __init__(self, failure: ChainFailure):
        self.failure = failure
        super().__init__(
            f"ProcessorChain could not build a unified kernel: {failure}. "
            f"Previously cached kernels remain usable for their own input contracts."
        )

    @property
    def processor_index(self) -> Optional[int]:
        return self.failure.processor_index

    @property
    def exception(self) -> BaseException:
        return self.failure.exception


_CHAIN_ERROR_CACHE: Dict[type, type] = {}


def _as_chain_error(failure: ChainFailure) -> ChainKernelBuildError:
    """
    Build a ChainKernelBuildError that also subclasses the original exception.

    Callers that used to catch (e.g.) ``ValueError`` from a processor keep
    working, while ``isinstance(exc, ChainKernelBuildError)`` and ``exc.failure``
    give programmatic access to the processor index and original exception.
    """
    original_type = type(failure.exception)
    if original_type is ChainKernelBuildError:
        return ChainKernelBuildError(failure)

    error_type = _CHAIN_ERROR_CACHE.get(original_type)
    if error_type is None:
        try:
            error_type = type(
                f"ChainKernelBuild{original_type.__name__}",
                (ChainKernelBuildError, original_type),
                {"__module__": __name__},
            )
        except TypeError:
            # Some exception types cannot be mixed (different C layouts).
            error_type = ChainKernelBuildError
        _CHAIN_ERROR_CACHE[original_type] = error_type

    if error_type is ChainKernelBuildError:
        return ChainKernelBuildError(failure)

    error = error_type.__new__(error_type)
    ChainKernelBuildError.__init__(error, failure)
    return error


class ChainSamplingRateError(ValueError):
    """
    Raised when a processor's sampling rate changed after the chain was built.

    Processing is refused so that the chain cannot silently produce audio at the
    wrong speed.
    """


@dataclass
class _KernelBundle:
    """A cached unified kernel together with the last stage's output contract."""

    kernel: SpatialSignal
    out_is_time: bool = True
    out_is_space: bool = False
    out_grid: Optional[Any] = None
    output_format: str = "SpatialSignal"
    enforce_real: bool = False
    # Last stage truncates its output (drops its own filter tail).
    last_truncates: bool = False
    # Samples the earlier stages add before the last stage runs.
    tail_before_last: int = 0
    # Declared input_length -> output_length contract of the last stage.
    out_length_fn: Optional[Any] = None


def _declared_out_length(processor) -> Optional[Callable[[int], int]]:
    """
    Output-length contract declared by a processor, or ``None``.

    A processor may declare ``output_length`` as a callable
    ``input_length -> output_length`` when its ``process`` is *not* a plain linear
    convolution of its filters with the input (e.g. ``BSMEncoder`` cuts the result
    to one sample per input sample).  The chain uses it to reproduce that
    truncation, so folding stays sample-for-sample equal to sequential processing.
    """
    declared = getattr(processor, "output_length", None)
    return declared if callable(declared) else None


@contextmanager
def _temporary_attrs(obj: Any, attrs: Dict[str, Any]):
    """Temporarily set attributes on ``obj`` and restore them afterwards."""
    saved = {}
    for name, value in attrs.items():
        if hasattr(obj, name):
            saved[name] = getattr(obj, name)
            setattr(obj, name, value)
    try:
        yield
    finally:
        for name, value in saved.items():
            setattr(obj, name, value)


class AbstractProcessor(ABC):
    """Abstract base class for audio processors."""

    def __init__(self, kernel: SpatialSignal = None):
        self.kernel = kernel

    @abstractmethod
    def process(self, data):
        """Must be implemented by the subclass to handle audio processing."""
        pass

    @property
    def fs(self):
        return self.kernel.fs


class ProcessorChain(AbstractProcessor):
    """
    Chains multiple processors together.
    The output of one processor is fed as input to the next.

    On the first call for a given input contract the chain is folded into a single
    equivalent convolution kernel (by pushing unit impulses through the chain) and
    the result is cached.  A cached kernel is valid only for the input contract it
    was built for — the input shape, sampling rate, time/frequency domain and
    space/SH (grid) domain.  When a different contract arrives the kernel is rebuilt
    automatically; the previous kernel is kept so that inputs matching its own
    contract keep working.

    If a rebuild fails, the chain keeps the last usable kernel and records a
    :class:`ChainFailure` (processor index + original exception) that can be read
    through :attr:`failure`.  A subsequent successful rebuild clears it.
    """

    # Keep a few contracts cached so concurrent callers using different contracts
    # do not evict each other on every call.
    _MAX_CACHED_CONTRACTS = 8

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

        self.unified_kernel: Optional[SpatialSignal] = None
        self._kernel_cache: "OrderedDict[tuple, _KernelBundle]" = OrderedDict()
        self._failure: Optional[ChainFailure] = None
        self._lock = threading.RLock()

        # Sampling rate contract captured at construction time.  Any later change
        # to a processor's fs is treated as an error because the folded kernel (and
        # every intermediate signal) would be at the wrong rate.
        self._construction_fs: Tuple[Any, ...] = tuple(p.fs for p in processors)

        # Declared output format of the last stage; kept in sync on every build so
        # that the chain always reports what its last processor declares.
        self._output_format = getattr(processors[-1], "_output_format", "SpatialSignal")
        self._enforce_real_values = getattr(
            processors[-1], "_enforce_real_values", False
        )

    @property
    def fs(self) -> int:
        return self.processors[0].fs

    @property
    def failure(self) -> Optional[ChainFailure]:
        """Info about the last failed unified-kernel rebuild, or ``None``."""
        return self._failure

    # Alias kept for callers that prefer an explicit name.
    @property
    def last_failure(self) -> Optional[ChainFailure]:
        return self._failure

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

        # A non-final stage that truncates its output makes the chain non-linear
        # (shift-invariant folding is impossible), so refuse it instead of silently
        # producing a folded kernel that disagrees with sequential processing.
        for i, processor in enumerate(processors[:-1]):
            if _declared_out_length(processor) is not None:
                raise ValueError(
                    f"Processor at index {i} ({processor!r}) truncates its output "
                    f"(declares 'output_length'), so the chain cannot be collapsed "
                    f"into one shift-invariant kernel. Only the last processor may "
                    f"truncate its output."
                )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(self, signal: SpatialSignal) -> Union[SpatialSignal, np.ndarray]:
        """Execute the chain, building/reusing a contract-bound unified kernel."""
        self._check_sampling_rates()
        self._validate_signal_shape(signal)
        contract = _contract_key(signal)

        bundle = self._get_cached_bundle(contract)
        if bundle is None:
            bundle = self._rebuild(contract, signal)

        return self._apply(bundle, signal)

    def calculate_unified_kernel(self, signal: SpatialSignal) -> SpatialSignal:
        """
        Calculate (and cache) the unified kernel for ``signal``'s input contract.

        Raises
        ------
        ValueError
            If the input shape is neither ``(1, ?, ?)`` nor ``(?, 1, ?)``.
        ChainKernelBuildError
            If a processor fails while being folded. The chain's previously built
            kernels remain usable; see :attr:`failure`.
        """
        self._check_sampling_rates()
        self._validate_signal_shape(signal)
        contract = _contract_key(signal)
        return self._rebuild(contract, signal).kernel

    def clear_failure(self) -> None:
        """Forget the last recorded rebuild failure."""
        with self._lock:
            self._failure = None

    # ------------------------------------------------------------------
    # Cache handling
    # ------------------------------------------------------------------

    def _get_cached_bundle(self, contract: tuple) -> Optional[_KernelBundle]:
        with self._lock:
            bundle = self._kernel_cache.get(contract)
            if bundle is not None:
                self._kernel_cache.move_to_end(contract)
                self.unified_kernel = bundle.kernel
            return bundle

    def _rebuild(self, contract: tuple, signal: SpatialSignal) -> _KernelBundle:
        """Build a kernel for ``contract``, updating cache/failure state."""
        with self._lock:
            # Another thread may have completed the same build while we waited.
            bundle = self._kernel_cache.get(contract)
            if bundle is not None:
                self._kernel_cache.move_to_end(contract)
                self.unified_kernel = bundle.kernel
                return bundle

            try:
                bundle = self._build_bundle(signal)
            except _KernelBuildFailure as exc:
                self._failure = ChainFailure(
                    processor_index=exc.processor_index,
                    processor=exc.processor,
                    exception=exc.exception,
                    contract=contract,
                )
                raise _as_chain_error(self._failure) from exc.exception
            except Exception as exc:  # pragma: no cover - defensive
                self._failure = ChainFailure(
                    processor_index=None,
                    processor=None,
                    exception=exc,
                    contract=contract,
                )
                raise _as_chain_error(self._failure) from exc

            self._kernel_cache[contract] = bundle
            self._kernel_cache.move_to_end(contract)
            while len(self._kernel_cache) > self._MAX_CACHED_CONTRACTS:
                self._kernel_cache.popitem(last=False)

            self.unified_kernel = bundle.kernel
            self._output_format = bundle.output_format
            self._enforce_real_values = bundle.enforce_real
            self._failure = None  # successful rebuild clears failure info
            return bundle

    # ------------------------------------------------------------------
    # Kernel construction
    # ------------------------------------------------------------------

    def _validate_signal_shape(self, signal: SpatialSignal) -> None:
        C1, C2 = signal.data.shape[0], signal.data.shape[1]
        if C1 != 1 and C2 != 1:
            raise ValueError(
                f"ProcessorChain expects input signal to be of shape (1, ?, ?) or "
                f"(?, 1, ?), and is of shape {signal.data.shape}"
            )

    def _build_bundle(self, signal: SpatialSignal) -> _KernelBundle:
        """
        Fold the chain into a single kernel for ``signal``'s contract.

        Folding is exact because every processor is linear.  A processor may declare
        ``output_length`` (a callable ``input_length -> output_length``) when it cuts
        its output short — ``BSMEncoder`` keeps one sample per input sample, i.e. it
        drops the tail its own filter adds.  Such a processor may also expose
        ``process_untruncated`` so the folded kernel keeps the full tail; the chain
        then applies the declared length once, at the end.
        """
        self._validate_signal_shape(signal)

        C1, C2 = signal.data.shape[0], signal.data.shape[1]
        kernels = []
        out_is_time = True
        out_is_space = False
        out_grid = None
        tail_before_last = 0

        last = self.processors[-1]
        last_truncates = _declared_out_length(last) is not None
        # A truncating last stage can expose its untruncated response so the folded
        # kernel carries the full tail.
        last_untruncated = getattr(last, "process_untruncated", None)
        last_untruncated = last_untruncated if callable(last_untruncated) else None

        probe_len = 1
        if last_truncates and last_untruncated is None:
            declared_impulse = getattr(last, "impulse_length", None)
            if declared_impulse is not None:
                probe_len = max(probe_len, int(declared_impulse))

        overrides = {}
        if hasattr(last, "_output_format"):
            overrides["_output_format"] = "SpatialSignal"
        if hasattr(last, "_enforce_real_values"):
            overrides["_enforce_real_values"] = False
        if last_truncates and last_untruncated is None:
            overrides["output_length"] = None

        with _PROCESSOR_OVERRIDE_LOCK:
            for c1 in range(C1):
                for c2 in range(C2):
                    impulse = np.zeros((C1, C2, probe_len), dtype=signal.data.dtype)
                    impulse[c1, c2, 0] = 1.0
                    res = SpatialSignal(
                        data=impulse,
                        fs=signal.fs,
                        is_time=signal.is_time,
                        is_space=signal.is_space,
                        grid=signal.grid,
                    )
                    for index, processor in enumerate(self.processors):
                        is_last = index == len(self.processors) - 1
                        try:
                            if is_last and last_untruncated is not None:
                                # Untruncated final response (full filter tail).
                                res = last_untruncated(res)
                            elif is_last and overrides:
                                with _temporary_attrs(processor, overrides):
                                    res = processor.process(res)
                            else:
                                res = processor.process(res)
                        except Exception as exc:
                            raise _KernelBuildFailure(index, processor, exc) from exc
                        if not isinstance(res, SpatialSignal):
                            raise _KernelBuildFailure(
                                index,
                                processor,
                                TypeError(
                                    "Processor returned "
                                    f"{type(res).__name__} during kernel folding; "
                                    "expected a SpatialSignal."
                                ),
                            )
                        if index == len(self.processors) - 2:
                            # Tail the earlier stages add, independent of input length.
                            tail_before_last = res.data.shape[-1] - probe_len
                    kernels.append(res.data)
                    out_is_time = bool(res.is_time)
                    out_is_space = bool(res.is_space)
                    out_grid = res.grid

        try:
            stacked = stack_kernels_dynamically(kernels)
        except Exception as exc:
            raise _KernelBuildFailure(None, None, exc) from exc

        kernel = SpatialSignal(
            data=stacked,
            fs=signal.fs,
            is_time=signal.is_time,
            is_space=signal.is_space,
            grid=signal.grid,
        )
        declared_format = getattr(last, "_output_format", "SpatialSignal")
        declared_real = bool(getattr(last, "_enforce_real_values", False))
        return _KernelBundle(
            kernel=kernel,
            out_is_time=out_is_time,
            out_is_space=out_is_space,
            out_grid=out_grid,
            output_format=declared_format,
            enforce_real=declared_real,
            last_truncates=last_truncates,
            tail_before_last=tail_before_last if last_truncates else 0,
            out_length_fn=_declared_out_length(last) if last_truncates else None,
        )

    # ------------------------------------------------------------------
    # Kernel application
    # ------------------------------------------------------------------

    def _apply(
        self, bundle: _KernelBundle, signal: SpatialSignal
    ) -> Union[SpatialSignal, np.ndarray]:
        kernel = bundle.kernel

        # Read the last stage's declaration at apply time so the chain output
        # always matches what that processor currently declares.  The lock keeps
        # this read consistent while another thread measures an impulse response
        # (which temporarily overrides those attributes on the same instance).
        with _PROCESSOR_OVERRIDE_LOCK:
            output_format = getattr(
                self.processors[-1], "_output_format", bundle.output_format
            )
            enforce_real = bool(
                getattr(
                    self.processors[-1],
                    "_enforce_real_values",
                    bundle.enforce_real,
                )
            )
            self._output_format = output_format
            self._enforce_real_values = enforce_real

        # Apply kernel directly without SH-order truncation.
        # convolve_sh would truncate to min(kernel.sh_order, signal.sh_order), which
        # breaks chains where the signal is mic data (sh_order=0 due to shape[1]=1).
        sig1 = (
            kernel.data
            if kernel.is_time
            else np.fft.ifft(kernel.data, axis=-1)
        )
        sig2 = signal.data if signal.is_time else np.fft.ifft(signal.data, axis=-1)
        # convolve_and_sum sums over axis 1 (ch). Kernel has N_in on axis 1.
        # Mic-format signals have N_in on axis 0 → transpose to (1, N_in, T).
        if sig2.shape[1] == 1 and sig1.shape[1] != 1:
            sig2 = sig2.transpose(1, 0, 2)
        data = convolve_and_sum(sig1, sig2, "time", "time")

        if bundle.last_truncates and bundle.out_length_fn is not None:
            # The last stage declares how many samples it keeps for the length it
            # actually sees (input length + tail added by the earlier stages).
            declared_keep = int(
                bundle.out_length_fn(signal.data.shape[-1] + bundle.tail_before_last)
            )
            if 0 <= declared_keep < data.shape[-1]:
                data = data[:, :, :declared_keep]

        if enforce_real:
            data = data.real

        if output_format == "numpy.ndarray":
            return data[:, 0, :].T

        out_is_space = bundle.out_is_space
        out_grid = bundle.out_grid
        if out_is_space and (
            out_grid is None or getattr(out_grid, "n_points", None) != data.shape[1]
        ):
            # A grid mismatching the folded output cannot be attached; report the
            # output as plain channels rather than raising from SpatialSignal.
            out_is_space = False
            out_grid = None

        return SpatialSignal(
            data=data,
            fs=signal.fs,
            is_time=bundle.out_is_time,
            is_space=out_is_space,
            grid=out_grid,
        )

    # ------------------------------------------------------------------
    # Sampling-rate guard
    # ------------------------------------------------------------------

    def _check_sampling_rates(self) -> None:
        """Refuse to process if any processor's fs changed after construction."""
        for index, processor in enumerate(self.processors):
            expected = self._construction_fs[index]
            current = processor.fs
            if current != expected:
                raise ChainSamplingRateError(
                    f"Processor at index {index} ({processor!r}) changed its sampling "
                    f"rate after the chain was constructed "
                    f"(was {expected} Hz, now {current} Hz). Refusing to process: the "
                    f"chain would produce audio at the wrong speed. Rebuild the "
                    f"ProcessorChain with processors at a consistent sampling rate."
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
        # Ensure ASM is calculated
        if self.kernel._cnm is None:
            self.kernel.calculate()

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
        self._output_length = lambda input_length: int(input_length)

    @property
    def fs(self):
        return self.kernel.fs

    @property
    def impulse_length(self) -> int:
        """
        Length of the beamformer impulse response, in samples.

        ``BSMEncoder.process`` cuts its output to the input length, so a length-1
        probe would lose the filter tail.  ``ProcessorChain`` probes with this length
        so the chain can be folded without losing that tail.
        """
        return int(np.asarray(self.kernel.cl).shape[0])

    def process_untruncated(self, microphone_signal: SpatialSignal) -> SpatialSignal:
        """Encode microphone signals keeping the full linear-convolution tail."""
        if not microphone_signal.is_time:
            raise ValueError(
                "BSMEncoder expects time domain input (Microphone Signals)."
            )
        return self.kernel.process_untruncated(microphone_signal)

    @property
    def output_length(self):
        """
        Declared output length of :meth:`process`: one sample per input sample.

        Matches ``BSM.process``'s truncation so the folded chain is sample-for-sample
        equal to sequential processing.
        """
        return self._output_length

    @output_length.setter
    def output_length(self, value):
        self._output_length = value

    def process(self, microphone_signal: SpatialSignal) -> SpatialSignal:
        """Encode microphone signals to binaural audio.

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
