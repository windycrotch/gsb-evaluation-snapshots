"""Dense 3D resampling for NumPy and Torch volumes and batches."""

from __future__ import annotations

from typing import TYPE_CHECKING, overload

import cv2
import numpy as np
import torch

from albucore.sampling3d import _normalize_border_value, _sample3d_torch_cpu, _sample3d_torch_cpu_batch
from albucore.tensor_bridge import numpy_to_tensor_layout, numpy_to_tensor_storage, tensor_to_numpy_channel_last

if TYPE_CHECKING:
    from albucore._types import ImageArrayT

__all__ = ["remap3d"]


def _sampling_grid_to_tensor(sampling_grid: np.ndarray | torch.Tensor) -> torch.Tensor:
    """Expose a NumPy grid as a Torch grid without writing it, or pass a Tensor grid through."""
    if isinstance(sampling_grid, np.ndarray):
        # The bridge keeps writable native storage shared and repairs read-only or
        # negative-stride views with one copy, so caller storage is never written and
        # Torch's non-writable-array warning is never triggered.
        return numpy_to_tensor_storage(sampling_grid)
    return sampling_grid


def _validate_sampling_grid(sampling_grid: np.ndarray | torch.Tensor) -> tuple[int, int, int]:
    """Reject unsupported grid shapes and dtypes before any volume work, and return its output size."""
    if not isinstance(sampling_grid, (np.ndarray, torch.Tensor)):
        msg = f"sampling_grid must be a NumPy array or CPU Tensor, got {type(sampling_grid).__name__}."
        raise TypeError(msg)
    shape = sampling_grid.shape
    if len(shape) != 4 or shape[-1] != 3:
        msg = f"sampling_grid must have shape (D_out, H_out, W_out, 3), got {tuple(shape)}."
        raise ValueError(msg)
    if isinstance(sampling_grid, np.ndarray):
        if sampling_grid.dtype != np.float32:
            msg = f"sampling_grid must use float32, got {sampling_grid.dtype}."
            raise ValueError(msg)
    elif sampling_grid.dtype != torch.float32:
        msg = f"sampling_grid must use float32, got {sampling_grid.dtype}."
        raise ValueError(msg)
    return int(shape[0]), int(shape[1]), int(shape[2])


def _remap3d_numpy(
    volume: np.ndarray,
    sampling_grid: torch.Tensor,
    interpolation: int,
    border_mode: int,
    border_values: np.ndarray,
) -> np.ndarray:
    """Bridge one ``DHWC`` NumPy volume through the shared CPU Torch sampler."""
    tensor = numpy_to_tensor_layout(volume, "CDHW")
    result = _sample3d_torch_cpu(tensor, sampling_grid, interpolation, border_mode, border_values)
    return tensor_to_numpy_channel_last(result, "CDHW")


def _remap3d_numpy_batch(
    volumes: np.ndarray,
    sampling_grid: torch.Tensor,
    interpolation: int,
    border_mode: int,
    border_values: np.ndarray,
) -> np.ndarray:
    """Bridge one ``NDHWC`` NumPy batch through the shared CPU Torch sampler."""
    tensor = numpy_to_tensor_layout(volumes, "NCDHW")
    result = _remap3d_torch_cpu_batch(tensor, sampling_grid, interpolation, border_mode, border_values)
    return tensor_to_numpy_channel_last(result, "NCDHW")


def _remap3d_torch_cpu_batch(
    volumes: torch.Tensor,
    sampling_grid: torch.Tensor,
    interpolation: int,
    border_mode: int,
    border_values: np.ndarray,
) -> torch.Tensor:
    """Sample wide prevalidated batches independently while sharing grid and fill preparation."""
    if volumes.shape[0] >= 4 and volumes.shape[1] > 1:
        # A native grid_sample batch is slower for these remap workloads.
        return torch.stack(
            [
                _sample3d_torch_cpu(volume, sampling_grid, interpolation, border_mode, border_values)
                for volume in volumes
            ],
        )
    return _sample3d_torch_cpu_batch(volumes, sampling_grid, interpolation, border_mode, border_values)


@overload
def remap3d(
    volume: ImageArrayT,
    sampling_grid: np.ndarray | torch.Tensor,
    interpolation: int = cv2.INTER_LINEAR,
    border_mode: int = cv2.BORDER_CONSTANT,
    border_value: float | tuple[float, ...] | np.ndarray | None = None,
) -> ImageArrayT: ...


@overload
def remap3d(
    volume: torch.Tensor,
    sampling_grid: np.ndarray | torch.Tensor,
    interpolation: int = cv2.INTER_LINEAR,
    border_mode: int = cv2.BORDER_CONSTANT,
    border_value: float | tuple[float, ...] | np.ndarray | None = None,
) -> torch.Tensor: ...


def remap3d(
    volume: np.ndarray | torch.Tensor,
    sampling_grid: np.ndarray | torch.Tensor,
    interpolation: int = cv2.INTER_LINEAR,
    border_mode: int = cv2.BORDER_CONSTANT,
    border_value: float | tuple[float, ...] | np.ndarray | None = None,
) -> np.ndarray | torch.Tensor:
    """Apply one normalized dense pull grid to a NumPy or CPU Tensor volume or batch.

    A single NumPy volume uses ``(D, H, W, C)`` and a batch uses ``(N, D, H, W, C)``.
    A single CPU Tensor uses ``(C, D, H, W)`` and a batch uses ``(N, C, D, H, W)``.
    ``sampling_grid`` has ``(D_out, H_out, W_out, 3)`` layout, contains normalized
    ``align_corners=False`` coordinates in ``(x, y, z)`` order, must be float32, and may
    be a NumPy array or CPU Torch tensor. Its spatial shape defines the output. One grid is
    shared by every volume, and every volume is sampled independently. Only ``uint8``,
    ``float16``, and ``float32`` volumes are supported. An empty batch returns a new
    zero-length array or tensor with the grid's output shape without sampling. Inputs are
    never modified in place.
    This primitive does not inspect the dense grid for identity.

    Args:
        volume: NumPy ``DHWC``/``NDHWC`` array or CPU Torch ``CDHW``/``NCDHW`` tensor.
        sampling_grid: Float32 normalized pull grid with shape ``(D_out, H_out, W_out, 3)``.
        interpolation: ``cv2.INTER_LINEAR`` for trilinear sampling or ``cv2.INTER_NEAREST``.
        border_mode: ``cv2.BORDER_CONSTANT`` or ``cv2.BORDER_REPLICATE``.
        border_value: Constant scalar or one value per channel, shared by the batch.

    Returns:
        A newly sampled volume or batch with the input container, dtype, layout, and channels.

    Raises:
        ValueError: If ``sampling_grid`` does not have rank 4 with a trailing axis of 3, or
            is not float32, or if ``border_value`` is not a scalar or a per-channel vector.
    """
    output_size = _validate_sampling_grid(sampling_grid)
    grid_tensor = _sampling_grid_to_tensor(sampling_grid)

    if isinstance(volume, np.ndarray):
        channels = volume.shape[-1]
        if volume.ndim == 5:
            border_values = _normalize_border_value(border_value, channels)
            if volume.shape[0] == 0:
                return np.empty((0, *output_size, channels), dtype=volume.dtype)
            return _remap3d_numpy_batch(volume, grid_tensor, interpolation, border_mode, border_values)
        border_values = _normalize_border_value(border_value, channels)
        return _remap3d_numpy(volume, grid_tensor, interpolation, border_mode, border_values)

    if volume.ndim == 5:
        channels = volume.shape[1]
        border_values = _normalize_border_value(border_value, channels)
        if volume.shape[0] == 0:
            return volume.new_empty((0, channels, *output_size))
        return _remap3d_torch_cpu_batch(volume, grid_tensor, interpolation, border_mode, border_values)

    channels = volume.shape[0]
    border_values = _normalize_border_value(border_value, channels)
    return _sample3d_torch_cpu(volume, grid_tensor, interpolation, border_mode, border_values)
