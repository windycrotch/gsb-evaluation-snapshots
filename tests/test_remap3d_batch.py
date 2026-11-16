# ruff: noqa: S101
"""Batch contracts and differential tests for ``remap3d``."""

from __future__ import annotations

import cv2
import numpy as np
import pytest
import torch

from albucore import remap3d


def _volume(dtype: type[np.uint8 | np.float32], channels: int, batch: int = 3) -> np.ndarray:
    """Build distinct non-cubic DHWC volumes to expose batch and axis mixing."""
    shape = (batch, 3, 4, 5, channels)
    values = np.arange(np.prod(shape), dtype=np.float32).reshape(shape)
    if dtype is np.uint8:
        return values.astype(np.uint8)
    return values / np.float32(10.0)


def _grid(size: tuple[int, int, int]) -> np.ndarray:
    """Build one nonlinear normalized shared grid with coordinates inside and outside the volume."""
    depth, height, width = size
    z, y, x = np.meshgrid(
        np.linspace(-1.2, 1.1, depth, dtype=np.float32),
        np.linspace(-0.9, 1.2, height, dtype=np.float32),
        np.linspace(-1.1, 0.8, width, dtype=np.float32),
        indexing="ij",
    )
    x += np.float32(0.07) * np.sin(y * np.float32(2.0))
    return np.stack((x, y, z), axis=-1)


def _identity_grid(size: tuple[int, int, int]) -> np.ndarray:
    """Create the normalized identity pull grid for a voxel-center volume."""
    axes = [((np.arange(length, dtype=np.float32) * 2.0 + 1.0) / length) - 1.0 for length in size]
    z, y, x = np.meshgrid(*axes, indexing="ij")
    return np.stack((x, y, z), axis=-1)


def _tensor_batch(volumes: np.ndarray) -> torch.Tensor:
    """Convert NDHWC to an explicitly declared NCDHW Tensor view."""
    return torch.from_numpy(volumes).permute(0, 4, 1, 2, 3)


@pytest.mark.parametrize("volume_container", ["numpy", "tensor"])
@pytest.mark.parametrize("grid_container", ["numpy", "tensor"])
@pytest.mark.parametrize("batch_size", [1, 4], ids=("n1", "n4"))
@pytest.mark.parametrize("dtype", [np.uint8, np.float32], ids=("uint8", "float32"))
@pytest.mark.parametrize("channels", [1, 5], ids=("c1", "c5"))
@pytest.mark.parametrize("interpolation", [cv2.INTER_NEAREST, cv2.INTER_LINEAR], ids=("nearest", "linear"))
@pytest.mark.parametrize(
    ("border_mode", "fill"),
    [
        (cv2.BORDER_CONSTANT, (11.0, 23.0, 37.0, 41.0, 53.0)),
        (cv2.BORDER_CONSTANT, 17.0),
        (cv2.BORDER_REPLICATE, None),
    ],
    ids=("per_channel_fill", "scalar_fill", "replicate"),
)
def test_remap3d_batch_matches_stacked_single_volume_calls(  # noqa: PLR0913, PLR0917
    volume_container: str,
    grid_container: str,
    batch_size: int,
    dtype: type[np.uint8 | np.float32],
    channels: int,
    interpolation: int,
    border_mode: int,
    fill: float | tuple[float, ...] | None,
) -> None:
    source = _volume(dtype, channels=channels, batch=batch_size)
    volumes = source if volume_container == "numpy" else _tensor_batch(source)
    grid_numpy = _grid((2, 5, 4))
    grid = grid_numpy if grid_container == "numpy" else torch.from_numpy(grid_numpy.copy())
    channel_fill = fill[:channels] if isinstance(fill, tuple) else fill
    result = remap3d(
        volumes,
        grid,
        interpolation=interpolation,
        border_mode=border_mode,
        border_value=channel_fill,
    )

    if volume_container == "numpy":
        expected = np.stack(
            [
                remap3d(
                    item,
                    grid,
                    interpolation=interpolation,
                    border_mode=border_mode,
                    border_value=channel_fill,
                )
                for item in volumes
            ],
        )
        assert isinstance(result, np.ndarray)
        np.testing.assert_array_equal(result, expected)
        assert result.shape == (batch_size, 2, 5, 4, channels)
    else:
        expected = torch.stack(
            [
                remap3d(
                    item,
                    grid,
                    interpolation=interpolation,
                    border_mode=border_mode,
                    border_value=channel_fill,
                )
                for item in volumes
            ],
        )
        assert isinstance(result, torch.Tensor)
        torch.testing.assert_close(result, expected, rtol=0, atol=0)
        assert result.shape == (batch_size, channels, 2, 5, 4)

    assert result.dtype == (dtype if volume_container == "numpy" else torch.from_numpy(np.empty((), dtype=dtype)).dtype)


@pytest.mark.parametrize("container", ["numpy", "tensor"])
def test_remap3d_batch_identity_grid_allocates_and_empty_batch_uses_grid_shape(container: str) -> None:
    """Remap never scans for identity, and empty output sizes come from the shared grid."""
    source = _volume(np.float32, channels=3)
    volumes = source if container == "numpy" else _tensor_batch(source)
    identity_grid = _identity_grid((3, 4, 5))
    result = remap3d(volumes, identity_grid, interpolation=cv2.INTER_NEAREST)
    expected = np.stack([remap3d(item, identity_grid, interpolation=cv2.INTER_NEAREST) for item in source])
    assert result is not volumes
    if isinstance(result, np.ndarray):
        np.testing.assert_array_equal(result, expected)
        assert not np.shares_memory(result, volumes)
        empty = np.empty((0, 3, 4, 5, 3), dtype=np.float32)
    else:
        torch.testing.assert_close(result, torch.from_numpy(expected).permute(0, 4, 1, 2, 3), rtol=0, atol=0)
        empty = _tensor_batch(np.empty((0, 3, 4, 5, 3), dtype=np.float32))

    empty_result = remap3d(empty, _grid((1, 2, 6)))
    assert empty_result.shape == ((0, 1, 2, 6, 3) if container == "numpy" else (0, 3, 1, 2, 6))
    assert empty_result.dtype == empty.dtype


def test_remap3d_batch_accepts_positive_strides_and_preserves_inputs() -> None:
    source = _volume(np.float32, channels=3, batch=2)
    volumes = source[:, :, :, ::-1, :]
    original = volumes.copy()
    grid_storage = np.empty((2, 5, 4, 6), dtype=np.float32)
    grid = grid_storage[..., ::2]
    grid[...] = _grid((2, 5, 4))
    grid_original = grid.copy()

    result = remap3d(volumes, grid, interpolation=cv2.INTER_LINEAR)
    expected = np.stack([remap3d(item, grid, interpolation=cv2.INTER_LINEAR) for item in volumes])

    np.testing.assert_array_equal(result, expected)
    np.testing.assert_array_equal(volumes, original)
    np.testing.assert_array_equal(grid, grid_original)
    assert not np.shares_memory(result, volumes)
    assert not np.shares_memory(result, grid)


def test_remap3d_batch_accepts_read_only_numpy_input() -> None:
    volumes = _volume(np.float32, channels=1, batch=4)
    volumes.setflags(write=False)
    grid = _grid((2, 5, 4))
    expected = np.stack([remap3d(item, grid) for item in volumes])

    result = remap3d(volumes, grid)

    np.testing.assert_array_equal(result, expected)
    assert not volumes.flags.writeable


def test_remap3d_batch_tensor_result_can_feed_a_trainable_torch_module() -> None:
    volumes = _tensor_batch(_volume(np.float32, channels=3, batch=2)).contiguous()
    volumes_original = volumes.clone()
    grid = torch.from_numpy(_grid((3, 4, 5)))
    grid_original = grid.clone()
    layer = torch.nn.Conv3d(3, 1, kernel_size=1)

    result = remap3d(volumes, grid)
    assert result.untyped_storage().data_ptr() != volumes.untyped_storage().data_ptr()
    assert result.untyped_storage().data_ptr() != grid.untyped_storage().data_ptr()
    torch.testing.assert_close(volumes, volumes_original, rtol=0, atol=0)
    torch.testing.assert_close(grid, grid_original, rtol=0, atol=0)
    layer(result).sum().backward()

    assert layer.weight.grad is not None


def _distinct_identity_volumes(channels: int, batch: int = 3) -> np.ndarray:
    """Build NDHWC volumes whose nonzero values identify the item and channel that produced them."""
    base = np.zeros((batch, 3, 4, 5, channels), dtype=np.float32)
    for item in range(batch):
        base[item] = np.float32(item + 1)
        base[item, ..., :] += np.arange(channels, dtype=np.float32)
    return base


@pytest.mark.parametrize("volume_container", ["numpy", "tensor"])
@pytest.mark.parametrize("grid_container", ["numpy", "tensor"])
@pytest.mark.parametrize("batch_size", [1, 2, 4, 7], ids=("n1", "n2", "n4", "n7"))
@pytest.mark.parametrize("channels", [1, 2, 5, 9], ids=("c1", "c2", "c5", "c9"))
def test_remap3d_batch_identity_grid_samples_each_volume_independently(
    volume_container: str,
    grid_container: str,
    batch_size: int,
    channels: int,
) -> None:
    """One identity grid must leave every item untouched, including wide single-channel batches."""
    source = _distinct_identity_volumes(channels, batch=batch_size)
    volumes = source if volume_container == "numpy" else _tensor_batch(source)
    grid_numpy = _identity_grid(source.shape[1:4])
    grid = grid_numpy if grid_container == "numpy" else torch.from_numpy(grid_numpy.copy())

    result = remap3d(volumes, grid, interpolation=cv2.INTER_NEAREST)

    if volume_container == "numpy":
        assert isinstance(result, np.ndarray)
        np.testing.assert_array_equal(result, source)
        assert not np.shares_memory(result, source)
    else:
        assert isinstance(result, torch.Tensor)
        torch.testing.assert_close(result, torch.from_numpy(source).permute(0, 4, 1, 2, 3), rtol=0, atol=0)
        assert result.untyped_storage().data_ptr() != volumes.untyped_storage().data_ptr()


@pytest.mark.parametrize("container", ["numpy", "tensor"])
@pytest.mark.parametrize("dtype", [np.uint8, np.float16, np.float32], ids=("uint8", "float16", "float32"))
@pytest.mark.parametrize("layout", ["contiguous", "strided"], ids=("contiguous", "strided"))
def test_remap3d_empty_batch_returns_a_fresh_grid_shaped_result(
    container: str,
    dtype: type[np.uint8 | np.float16 | np.float32],
    layout: str,
) -> None:
    """An empty batch is a valid call: shape, dtype, container, and layout come from inputs and grid."""
    channels = 3 if layout == "strided" else 6
    storage = np.empty((0, 3, 4, 5, 6), dtype=dtype)
    volumes = storage[..., ::2] if layout == "strided" else storage
    if container == "tensor":
        volumes = _tensor_batch(volumes)
    grid = _grid((2, 5, 4))

    result = remap3d(volumes, grid)

    expected_shape = (0, 2, 5, 4, channels) if container == "numpy" else (0, channels, 2, 5, 4)
    assert result.shape == expected_shape
    expected_dtype = np.dtype(dtype) if container == "numpy" else torch.from_numpy(np.empty((), dtype=dtype)).dtype
    assert result.dtype == expected_dtype
    if container == "numpy":
        assert result.flags.writeable
        assert result.base is None
        assert result.size == 0
    else:
        assert isinstance(result, torch.Tensor)
        assert result.is_contiguous()
        assert result.numel() == 0


@pytest.mark.parametrize("channels", [1, 4, 5], ids=("c1", "c4", "c5"))
@pytest.mark.parametrize("batch_size", [1, 4], ids=("n1", "n4"))
def test_remap3d_batch_per_channel_constant_fill_matches_single_volume_calls(
    channels: int,
    batch_size: int,
) -> None:
    """Every all-outside pull must return exactly its own channel's fill value."""
    volumes = _volume(np.float32, channels=channels, batch=batch_size)
    fill = tuple(float(10 + 7 * channel) for channel in range(channels))
    outside_grid = np.full((1, 2, 3, 3), np.float32(-1.5), dtype=np.float32)

    numpy_result = remap3d(volumes, outside_grid, border_value=fill)
    numpy_expected = np.stack([remap3d(item, outside_grid, border_value=fill) for item in volumes])
    np.testing.assert_array_equal(numpy_result, numpy_expected)
    np.testing.assert_array_equal(numpy_result[0, 0, 0, 0], np.asarray(fill, dtype=np.float32))

    tensor_volumes = _tensor_batch(volumes)
    tensor_result = remap3d(tensor_volumes, torch.from_numpy(outside_grid), border_value=fill)
    tensor_expected = torch.stack([remap3d(item, outside_grid, border_value=fill) for item in tensor_volumes])
    torch.testing.assert_close(tensor_result, tensor_expected, rtol=0, atol=0)
    torch.testing.assert_close(
        tensor_result[0, :, 0, 0, 0],
        torch.from_numpy(np.asarray(fill, dtype=np.float32)),
        rtol=0,
        atol=0,
    )


@pytest.mark.parametrize("border_value", [None, 0.0, 17.0, (11.0, 23.0, 37.0), np.array((1.5, -2.0, 7.0))])
@pytest.mark.parametrize("grid_container", ["numpy", "tensor"])
def test_remap3d_batch_numpy_and_tensor_grids_agree_for_every_fill_form(
    border_value: float | tuple[float, ...] | np.ndarray | None,
    grid_container: str,
) -> None:
    """The grid container must not change results, for scalar, tuple, and array fills."""
    volumes = _volume(np.float32, channels=3, batch=4)
    grid_numpy = _grid((2, 5, 4))
    grid = grid_numpy if grid_container == "numpy" else torch.from_numpy(grid_numpy.copy())

    result = remap3d(volumes, grid, interpolation=cv2.INTER_LINEAR, border_value=border_value)
    reference = remap3d(volumes, grid_numpy, interpolation=cv2.INTER_LINEAR, border_value=border_value)
    expected = np.stack(
        [remap3d(item, grid_numpy, interpolation=cv2.INTER_LINEAR, border_value=border_value) for item in volumes],
    )

    np.testing.assert_array_equal(result, reference)
    np.testing.assert_array_equal(result, expected)


@pytest.mark.parametrize("container", ["numpy", "tensor"])
def test_remap3d_batch_read_only_and_negative_stride_grids_are_supported(container: str) -> None:
    """Callers may pass any non-writable or reversed float32 grid view without mutation."""
    source = _volume(np.float32, channels=2, batch=3)
    volumes = source if container == "numpy" else _tensor_batch(source)
    backing = np.ascontiguousarray(_grid((2, 5, 4)))
    read_only = backing.copy()
    read_only.setflags(write=False)
    negative = backing[:, ::-1]
    negative_copy = negative.copy()

    read_only_result = remap3d(volumes, read_only)
    negative_result = remap3d(volumes, negative)
    contiguous_result = remap3d(volumes, negative_copy)

    np.testing.assert_array_equal(negative, negative_copy)
    assert not read_only.flags.writeable
    np.testing.assert_array_equal(read_only_result, remap3d(volumes, backing))
    if container == "numpy":
        np.testing.assert_array_equal(negative_result, contiguous_result)
    else:
        torch.testing.assert_close(negative_result, contiguous_result, rtol=0, atol=0)


@pytest.mark.parametrize("container", ["numpy", "tensor"])
@pytest.mark.parametrize("batch_size", [0, 3], ids=("empty", "batch"))
@pytest.mark.parametrize(
    "invalid_grid",
    [
        np.zeros((2, 3), dtype=np.float32),
        np.zeros((2, 3, 3), dtype=np.float32),
        np.zeros((1, 2, 3, 4, 3), dtype=np.float32),
        np.zeros((2, 3, 4, 2), dtype=np.float32),
        np.zeros((2, 3, 4, 3), dtype=np.float64),
        np.zeros((2, 3, 4, 3), dtype=np.float16),
        np.zeros((2, 3, 4, 3), dtype=np.int32),
    ],
    ids=("rank2", "rank3", "rank5", "last_axis_2", "float64", "float16", "int32"),
)
def test_remap3d_rejects_invalid_grid_shape_or_dtype(
    container: str,
    batch_size: int,
    invalid_grid: np.ndarray,
) -> None:
    """Rank and float32 dtype are contract requirements, including for a zero-length batch."""
    volumes = np.empty((batch_size, 3, 4, 5, 2), dtype=np.float32)
    if container == "tensor":
        volumes = _tensor_batch(volumes)
        grids: tuple[np.ndarray | torch.Tensor, ...] = (invalid_grid, torch.from_numpy(invalid_grid.copy()))
    else:
        grids = (invalid_grid,)

    for grid in grids:
        with pytest.raises(ValueError, match="sampling_grid"):
            remap3d(volumes, grid)


@pytest.mark.parametrize("container", ["numpy", "tensor"])
def test_remap3d_batch_rejects_border_values_without_one_entry_per_channel(container: str) -> None:
    source = _volume(np.float32, channels=3, batch=2)
    volumes = source if container == "numpy" else _tensor_batch(source)
    grid = _grid((2, 5, 4))

    for border_value in ((11.0, 23.0), (11.0, 23.0, 37.0, 41.0), np.ones((2, 3), dtype=np.float32)):
        with pytest.raises(ValueError, match="border_value"):
            remap3d(volumes, grid, border_value=border_value)
