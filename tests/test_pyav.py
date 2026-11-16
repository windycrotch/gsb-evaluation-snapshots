import gc
import io
import multiprocessing
import warnings
from contextlib import ExitStack
from pathlib import Path

import numpy as np
import pytest
from conftest import IS_PYPY

import imageio.v3 as iio

av = pytest.importorskip("av", reason="pyAV is not installed.")

from av.video.format import names as video_format_names  # type: ignore # noqa: E402

from imageio.plugins.pyav import _format_to_dtype  # noqa: E402

AV_VERSION = tuple(int(x) for x in av.__version__.split("."))

# the maintainer of pyAV hasn't responded to my bug reports in over 4 months so
# I am disabling test on pypy to stay sane.
if IS_PYPY:
    pytest.skip("pyAV sometimes causes segfaults on Pypy.", allow_module_level=True)


def test_mp4_read(test_images: Path):
    with av.open(str(test_images / "cockatoo.mp4"), "r") as container:
        for idx, frame in enumerate(container.decode(video=0)):
            if idx == 4:
                break

    # ImageIO serves the data channel-first
    expected = frame.to_ndarray(format="rgb24")

    result = iio.imread(
        test_images / "cockatoo.mp4", index=4, plugin="pyav", format="rgb24"
    )
    assert np.allclose(result, expected)

    result = iio.imread(
        test_images / "cockatoo.mp4",
        index=4,
        plugin="pyav",
        constant_framerate=False,
        format="rgb24",
    )
    assert np.allclose(result, expected)


def test_mp4_read_bytes(test_images):
    encoded_video = (test_images / "cockatoo.mp4").read_bytes()

    img_expected = iio.imread(encoded_video, index=5)
    img = iio.imread(encoded_video, plugin="pyav", index=5)

    assert np.allclose(img, img_expected)


def test_mp4_writing(tmp_path, test_images):
    frames = iio.imread(test_images / "newtonscradle.gif")

    mp4_bytes = iio.imwrite(
        "<bytes>",
        frames,
        extension=".mp4",
        plugin="pyav",
        codec="h264",
    )

    # h264 writing is not deterministic and RGB -> YUV is lossy
    # so I have no good ideas how to do serious assertions on the file
    assert mp4_bytes is not None


def test_metadata(test_images: Path):
    with iio.imopen(str(test_images / "cockatoo.mp4"), "r", plugin="pyav") as plugin:
        if AV_VERSION >= (10, 0, 0):
            with warnings.catch_warnings(record=True):
                meta = plugin.metadata()
        else:
            meta = plugin.metadata()

        assert meta["profile"] == "High 4:4:4 Predictive"
        assert meta["codec"] == "h264"
        assert meta["encoder"] == "Lavf56.4.101"
        assert meta["duration"] == 14
        assert meta["fps"] == 20.0

        if AV_VERSION >= (10, 0, 0):
            with warnings.catch_warnings(record=True):
                meta = plugin.metadata(index=4)
        else:
            meta = plugin.metadata(index=4)

        assert meta["time"] == 0.2
        assert meta["key_frame"] is False


def test_properties(test_images: Path):
    with iio.imopen(str(test_images / "cockatoo.mp4"), "r", plugin="pyav") as plugin:
        with pytest.raises(IOError):
            # subsampled format
            plugin.properties(format="yuv420p")

        with pytest.raises(IOError):
            # components per channel differs
            plugin.properties(format="nv24")

        props = plugin.properties()
        assert props.shape == (280, 720, 1280, 3)
        assert props.dtype == np.uint8
        assert props.n_images == 280
        assert props.is_batch is True

        props = plugin.properties(index=4, format="rgb48")
        assert props.shape == (720, 1280, 3)
        assert props.dtype == np.uint16
        assert props.n_images is None
        assert props.is_batch is False

        props = plugin.properties(index=5)
        assert props.shape == (720, 1280, 3)
        assert props.dtype == np.uint8
        assert props.n_images is None
        assert props.is_batch is False


def test_video_format_to_dtype():
    # technically not fake, but mostly hwaccel formats which are unsupported in
    # pyAV at the time of writing (2022/03/06). PyAV can instantiate them, but
    # they have no components. Therefore we can't deduce an appropriate dtype
    # from these so we have to raise instead.
    fake_formats = [
        "amf",
        "cuda",
        "d3d11",
        "d3d11va_vld",
        "d3d12",
        "drm_prime",
        "dxva2_vld",
        "mediacodec",
        "mmal",
        "ohcodec",
        "opencl",
        "qsv",
        "vaapi_idct",
        "vaapi_moco",
        "vaapi_vld",
        "vaapi",
        "vdpau",
        "videotoolbox_vld",
        "vulkan",
        "xvmc",
    ]

    for name in video_format_names:
        format = av.VideoFormat(name)

        if name in fake_formats:
            # should fail
            with pytest.raises(ValueError):
                _format_to_dtype(format)
        else:
            # should succseed
            _format_to_dtype(format)


def test_filter_sequence(test_images):
    frames = iio.imread(
        test_images / "cockatoo.mp4",
        plugin="pyav",
        filter_sequence=[
            ("drawgrid", "w=iw/3:h=ih/3:t=2:c=white@0.5"),
            ("scale", {"size": "vga", "flags": "lanczos"}),
            ("tpad", "start=3"),
        ],
    )

    assert frames.shape == (283, 480, 640, 3)

    frames = iio.imread(
        test_images / "cockatoo.mp4",
        plugin="pyav",
        filter_sequence=[
            ("framestep", "5"),
            ("scale", {"size": "vga", "flags": "lanczos"}),
        ],
    )

    assert frames.shape == (56, 480, 640, 3)


def test_filter_graph(test_images):
    frames = iio.imread(
        test_images / "cockatoo.mp4",
        plugin="pyav",
        filter_graph=(
            {
                "step": ("framestep", "5"),
                "scale": ("scale", {"size": "vga", "flags": "lanczos"}),
            },
            [
                ("video_in", "step", 0, 0),
                ("step", "scale", 0, 0),
                ("scale", "video_out", 0, 0),
            ],
        ),
    )

    assert frames.shape == (56, 480, 640, 3)


def test_write_bytes(test_images):
    img = iio.imread(
        test_images / "cockatoo.mp4",
        plugin="pyav",
        filter_sequence=[
            ("framestep", "5"),
            ("scale", {"size": "vga", "flags": "lanczos"}),
        ],
    )
    img_bytes = iio.imwrite(
        "<bytes>",
        img,
        extension=".mp4",
        plugin="pyav",
        codec="h264",
    )

    assert img_bytes is not None


def test_read_png(test_images):
    img_expected = iio.imread(test_images / "chelsea.png", plugin="pillow")
    img_actual = iio.imread(test_images / "chelsea.png", plugin="pyav")

    assert np.allclose(img_actual, img_expected)


def test_write_png(test_images, tmp_path):
    img_expected = iio.imread(test_images / "chelsea.png", plugin="pyav", index=0)
    iio.imwrite(
        tmp_path / "out.png",
        img_expected,
        plugin="pyav",
        codec="png",
        is_batch=False,
        out_pixel_format="rgb24",
    )
    img_actual = iio.imread(tmp_path / "out.png", plugin="pyav")

    assert np.allclose(img_actual, img_expected)


def test_gif_write(test_images, tmp_path):
    frames_expected = iio.imread(
        test_images / "newtonscradle.gif", plugin="pyav", format="gray"
    )

    # touch the codepath that creates a video from a list of frames
    frame_list = list(frames_expected)

    iio.imwrite(
        tmp_path / "test.gif",
        frame_list,
        plugin="pyav",
        codec="gif",
        out_pixel_format="gray",
        in_pixel_format="gray",
    )
    frames_actual = iio.imread(tmp_path / "test.gif", plugin="pyav", format="gray")
    assert np.allclose(frames_actual, frames_expected)

    # with iio.v3.imopen("test2.gif", "w", plugin="pyav", container_format="gif", legacy_mode=False) as file:
    #     file.write(frames, codec="gif", out_pixel_format="gray", in_pixel_format="gray")


def test_raises_exception_when_shapes_mismatch(test_images, tmp_path):
    frame_list = [
        np.ones((200, 150), dtype=np.uint8),
        np.ones((256, 256), dtype=np.uint8),
    ]

    with pytest.raises(ValueError):
        iio.imwrite(
            tmp_path / "test.gif",
            frame_list,
            plugin="pyav",
            codec="gif",
            out_pixel_format="gray",
            in_pixel_format="gray",
        )


def test_gif_gen(test_images, tmp_path):
    frames = iio.imread(
        test_images / "realshort.mp4",
        plugin="pyav",
        format="rgb24",
        filter_sequence=[
            ("fps", "50"),
            ("scale", "320:-1:flags=lanczos"),
        ],
    )

    iio.imwrite(
        tmp_path / "test.gif",
        frames,
        plugin="pyav",
        codec="gif",
        fps=50,
        out_pixel_format="pal8",
        filter_graph=(
            {  # Nodes
                "split": ("split", ""),
                "palettegen": ("palettegen", ""),
                "paletteuse": ("paletteuse", ""),
            },
            [  # Edges
                ("video_in", "split", 0, 0),
                ("split", "palettegen", 0, 0),
                ("split", "paletteuse", 1, 0),
                ("palettegen", "paletteuse", 0, 1),
                ("paletteuse", "video_out", 0, 0),
            ],
        ),
    )


def test_variable_fps_seek(test_images):
    with iio.imopen(test_images / "cockatoo.mp4", "r", plugin="pyav") as file:
        expected = iio.imread(test_images / "cockatoo.mp4", index=15, plugin="pyav")
        actual = file.read(index=15, constant_framerate=False)
        assert np.allclose(actual, expected)

        expected = iio.imread(test_images / "cockatoo.mp4", index=3, plugin="pyav")
        actual = file.read(index=3, constant_framerate=False)

        assert np.allclose(actual, expected)

    meta = iio.immeta(
        test_images / "cockatoo.mp4", index=3, plugin="pyav", constant_framerate=False
    )
    assert meta["interlaced_frame"] is False


def test_multiple_writes(test_images):
    # Note: when opening videos via imopen prefer using the additional API for
    # writing (see eg. test_procedual_writing)
    out_buffer = io.BytesIO()
    with iio.imopen(out_buffer, "w", plugin="pyav", extension=".mp4") as file:
        for frame in iio.imiter(
            test_images / "newtonscradle.gif",
            plugin="pyav",
            format="rgba",
        ):
            file.write(frame, is_batch=False, codec="h264", in_pixel_format="rgba")

    actual = out_buffer.getvalue()
    assert actual is not None


def test_exceptions(tmp_path):
    with pytest.raises(IOError):
        iio.imopen(io.BytesIO(), "w", plugin="pyav", legacy_mode=False)

    with pytest.raises(IOError):
        iio.imopen(b"nonsense", "r", plugin="pyav", legacy_mode=False)

    foo_file = tmp_path / "faulty.mp4"
    foo_file.write_bytes(b"nonsense")
    with pytest.raises(IOError):
        iio.imopen(foo_file, "r", plugin="pyav", legacy_mode=False)


def test_native_pixformat_reading(test_images):
    frames = iio.imread(
        test_images / "cockatoo.mp4",
        index=5,
        plugin="pyav",
        format=None,
    )

    # cockatoo.mp4 uses YUV444p
    assert frames.shape == (3, 720, 1280)


def test_invalid_resource(tmp_path):
    img = np.zeros((100, 100, 3))

    with pytest.raises(IOError):
        iio.imwrite(tmp_path / "foo.abc", img, plugin="pyav")


def test_bayer_write():
    image_shape = (128, 128)
    image = np.zeros(image_shape, dtype="uint8")
    buffer = io.BytesIO()

    with iio.imopen(buffer, "w", plugin="pyav", extension=".mp4") as file:
        image[...] = 0
        for i in range(256):
            image[::2, ::2] = i
            file.write(
                image, is_batch=False, codec="h264", in_pixel_format="bayer_rggb8"
            )

        image[...] = 0
        for i in range(256):
            image[0::2, 1::2] = i
            image[1::2, 0::2] = i
            file.write(
                image, is_batch=False, codec="h264", in_pixel_format="bayer_rggb8"
            )

        image[...] = 0
        for i in range(256):
            image[1::2, 1::2] = i
            file.write(
                image, is_batch=False, codec="h264", in_pixel_format="bayer_rggb8"
            )

    buffer.seek(0)
    img = iio.imread(buffer, plugin="pyav")
    assert img.shape == (768, 128, 128, 3)


def test_sequential_reading(test_images):
    expected_imgs = [
        iio.imread(test_images / "cockatoo.mp4", plugin="pyav", index=1),
        iio.imread(test_images / "cockatoo.mp4", plugin="pyav", index=5),
    ]

    with iio.imopen(test_images / "cockatoo.mp4", "r", plugin="pyav") as img_file:
        first_read = img_file.read(index=1, thread_type="FRAME", thread_count=2)
        second_read = img_file.read(index=5)
        actual_imgs = [first_read, second_read]

    assert np.allclose(actual_imgs, expected_imgs)


@pytest.mark.skip(
    reason="PyAV no longer supports DASH natively. This needs separate investigation."
)
@pytest.mark.needs_internet
def test_uri_reading(test_images):
    uri = "https://dash.akamaized.net/dash264/TestCases/2c/qualcomm/1/MultiResMPEG2.mpd"

    with av.open(uri) as container:
        for idx, frame in enumerate(container.decode(video=0)):
            if idx < 250:
                continue

            expected = frame.to_ndarray(format="rgb24")
            break

    actual = iio.imread(uri, plugin="pyav", index=250)

    assert np.allclose(actual, expected)


def test_seek_vs_iter(test_images):
    img_path = test_images / "cockatoo.mp4"
    n_frames = iio.improps(img_path, plugin="pyav").shape[0]
    test_indices = [30, 31, 32, 76, 158, n_frames - 1]

    with iio.imopen(img_path, "r", plugin="pyav") as file:
        for idx, expected in enumerate(
            iio.imiter(img_path, plugin="pyav", thread_type="FRAME")
        ):
            if idx not in test_indices:
                continue

            actual = file.read(index=idx, thread_type="FRAME")
            assert np.allclose(actual, expected)

            actual = iio.imread(img_path, plugin="pyav", index=idx)
            assert np.allclose(actual, expected)


def test_procedual_writing(test_images):
    buffer = io.BytesIO()
    with iio.imopen(buffer, "w", plugin="pyav", extension=".mp4") as file:
        file.init_video_stream("h264")
        for frame in iio.imiter(test_images / "cockatoo.mp4", plugin="pyav"):
            file.write_frame(frame)

    buffer.seek(0)
    actual = iio.imread(buffer, plugin="pyav", extension=".mp4")

    assert actual.shape == (280, 720, 1280, 3)


def test_multi_frame_libx264_write(tmp_path):
    # libx264 buffers its first frames, so the muxer's frame count stayed at
    # zero after the first write and the stream size was assigned a second
    # time, which av 18.1 refuses once the encoder is open
    frames = np.zeros((5, 64, 64, 3), dtype=np.uint8)
    frames[:, 8:24, 8:24] = 255
    out = tmp_path / "out.mp4"

    iio.imwrite(out, frames, plugin="pyav", codec="libx264", fps=10)
    actual = iio.imread(out, plugin="pyav")

    assert actual.shape == frames.shape


def test_procedual_writing_with_filter(test_images):
    buffer = io.BytesIO()
    with iio.imopen(buffer, "w", plugin="pyav", extension=".mp4") as file:
        file.init_video_stream("h264", fps=30)
        file.set_video_filter(
            filter_sequence=[
                ("scale", {"size": "vga", "flags": "lanczos"}),
            ]
        )
        for frame in iio.imiter(
            test_images / "cockatoo.mp4", plugin="pyav", format="yuv444p"
        ):
            file.write_frame(frame, pixel_format="yuv444p")

    buffer.seek(0)
    actual = iio.imread(buffer, plugin="pyav", extension=".mp4")

    assert actual.shape == (280, 480, 640, 3)


def test_rotation_flag_metadata(test_images, tmp_path):
    with iio.imopen(tmp_path / "test.mp4", "w", plugin="pyav") as file:
        file.init_video_stream("h264")
        file.container_metadata["comment"] = "This video has a rotation flag."
        file.video_stream_metadata["rotate"] = "90"

        for _ in range(5):
            for frame in iio.imiter(test_images / "newtonscradle.gif"):
                file.write_frame(frame)

    if AV_VERSION >= (10, 0, 0):
        pytest.xfail("PyAV >= 10.0.0 doesn't extract the rotation flag.")
    else:
        pytest.xfail("PyAV v10.0.0+ doesn't extract the rotation flag.")


def test_read_filter(test_images):
    image = iio.imread(
        test_images / "cockatoo.mp4",
        index=5,
        plugin="pyav",
        filter_sequence=[("scale", {"size": "vga", "flags": "lanczos"})],
    )

    assert image.shape == (480, 640, 3)


def test_write_float_fps(test_images):
    fps = 3.5
    frames = iio.imread(test_images / "cockatoo.mp4", plugin="pyav")
    buffer = iio.imwrite(
        "<bytes>", frames, extension=".mp4", codec="h264", plugin="pyav", fps=fps
    )

    assert iio.immeta(buffer, plugin="pyav")["fps"] == fps


def test_keyframe_intervals(test_images):
    buffer = io.BytesIO()
    with ExitStack() as ctx:
        in_file = ctx.enter_context(
            iio.imopen(test_images / "cockatoo.mp4", "r", plugin="pyav")
        )
        out_file = ctx.enter_context(
            iio.imopen(buffer, "w", plugin="pyav", extension=".mp4")
        )

        out_file.init_video_stream(
            "h264", max_keyframe_interval=5, force_keyframes=True
        )

        for idx in range(50):
            frame = in_file.read(index=idx)
            out_file.write_frame(frame)

    buffer.seek(0)
    key_dist = [0]
    i_dist = [0]
    with iio.imopen(buffer, "r", plugin="pyav") as file:
        n_frames = file.properties().shape[0]
        for idx in range(1, n_frames):
            metatada = file.metadata(index=idx)
            if metatada["frame_type"] == "I":
                i_dist.append(idx)
            if metatada["key_frame"]:
                key_dist.append(idx)

    assert np.max(np.diff(i_dist)) <= 5
    assert np.max(np.diff(key_dist)) <= 5


@pytest.mark.needs_internet
def test_trim_filter(test_images):
    # this is a regression test for:
    # https://github.com/imageio/imageio/issues/951
    frames = iio.imread(
        "imageio:cockatoo.mp4",
        plugin="pyav",
        filter_sequence=[("trim", {"start": "00:00:01", "end": "00:00:02"})],
    )

    assert frames.shape == (20, 720, 1280, 3)


def subprocess(func, conn):
    try:
        result = func()
        conn.send(result)
    except BaseException as e:
        conn.send(e)


def test_lagging_video_stream(test_images):
    # this is a regression test
    # see: https://github.com/imageio/imageio/issues/1095

    with iio.imopen(
        test_images / "cockatoo.mp4",
        "r",
        plugin="pyav",
    ) as img_file:
        for idx in range(50):
            img_file.read(index=idx)

    output, input = multiprocessing.Pipe()
    proc = multiprocessing.Process(target=subprocess, args=(gc.collect, input))

    proc.start()
    if not output.poll(timeout=5):
        proc.kill()
        raise TimeoutError("Test Subprocess failed to respond in time.")


def _write_test_video(path: Path, n_frames: int = 12, size: int = 32, fps: int = 10):
    """Write a small, locally generated, gradient video and return its frames."""

    frames = np.zeros((n_frames, size, size, 3), dtype=np.uint8)
    for idx in range(n_frames):
        frames[idx, ...] = idx * (255 // max(n_frames, 1))

    iio.imwrite(
        path,
        frames,
        plugin="pyav",
        codec="mpeg4",
        fps=fps,
        out_pixel_format="yuv420p",
    )

    # re-read to get the decoded frames; encoding is lossy, so comparing
    # against the re-read frames keeps the tests independent of the codec
    return iio.imread(path, plugin="pyav")


def test_delayed_filter_single_frame_read(tmp_path):
    # `tpad` prepends frames, so the filter holds frames back and emits several
    # frames for the very first input frame
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    filter_sequence = [("tpad", "start=3")]

    with iio.imopen(in_path, "r", plugin="pyav") as file:
        # one frame at a time; this is the path that used to drop frames
        actual = [
            file.read(index=idx, filter_sequence=filter_sequence)
            for idx in range(expected.shape[0] + 3)
        ]

    # the padded frames are blank, the rest must match the source video
    assert np.allclose(actual[:3], 0)
    assert np.allclose(actual[3:], expected)

    # comparing against a bulk read makes sure that no frame was skipped or
    # duplicated along the way
    bulk = iio.imread(in_path, plugin="pyav", filter_sequence=filter_sequence)
    assert np.allclose(actual, bulk)


def test_delayed_filter_single_frame_read_no_skip_or_duplicate(tmp_path):
    # `framestep` drops frames; the filter still emits them one at a time and
    # the remaining frames must not be lost when reading them individually
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    filter_sequence = [("framestep", "2")]

    bulk = iio.imread(in_path, plugin="pyav", filter_sequence=filter_sequence)

    with iio.imopen(in_path, "r", plugin="pyav") as file:
        actual = [
            file.read(index=idx, filter_sequence=filter_sequence)
            for idx in range(bulk.shape[0])
        ]

    assert np.allclose(actual, bulk)
    assert np.allclose(bulk, expected[::2][: bulk.shape[0]])

    # reading past the end of the filtered video raises
    with iio.imopen(in_path, "r", plugin="pyav") as file:
        with pytest.raises(StopIteration):
            file.read(index=bulk.shape[0], filter_sequence=filter_sequence)


def test_delayed_filter_single_frame_read_random_access(tmp_path):
    # a delayed filter can't be rewound, so a backwards jump has to restart it
    in_path = tmp_path / "in.mp4"
    _write_test_video(in_path)

    filter_sequence = [("tpad", "start=2")]
    bulk = iio.imread(in_path, plugin="pyav", filter_sequence=filter_sequence)

    with iio.imopen(in_path, "r", plugin="pyav") as file:
        assert np.allclose(file.read(index=5, filter_sequence=filter_sequence), bulk[5])
        assert np.allclose(file.read(index=1, filter_sequence=filter_sequence), bulk[1])
        assert np.allclose(file.read(index=1, filter_sequence=filter_sequence), bulk[1])
        assert np.allclose(file.read(index=0, filter_sequence=filter_sequence), bulk[0])


def test_delayed_filter_bulk_read(tmp_path):
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    # a filter that pads the start adds frames
    padded = iio.imread(
        in_path,
        plugin="pyav",
        filter_sequence=[("tpad", "start=3")],
    )
    assert padded.shape[0] == expected.shape[0] + 3
    assert np.allclose(padded[:3], 0)
    assert np.allclose(padded[3:], expected)

    # a filter that drops frames removes them
    stepped = iio.imread(
        in_path,
        plugin="pyav",
        filter_sequence=[("framestep", "2")],
    )
    assert stepped.shape[0] == int(np.ceil(expected.shape[0] / 2))
    assert np.allclose(stepped, expected[::2])

    # a filter that buffers the whole video only emits on EOF
    reversed_frames = iio.imread(
        in_path,
        plugin="pyav",
        filter_sequence=[("reverse", "")],
    )
    assert reversed_frames.shape[0] == expected.shape[0]
    assert np.allclose(reversed_frames, expected[::-1])


def test_delayed_filter_bulk_read_flushed_after_eof(tmp_path):
    # `tpad stop=3` appends frames, which the filter can only emit once it has
    # been flushed at the end of the video
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    padded = iio.imread(
        in_path,
        plugin="pyav",
        filter_sequence=[("tpad", "stop=3")],
    )
    assert padded.shape[0] == expected.shape[0] + 3
    assert np.allclose(padded[: expected.shape[0]], expected)


def test_delayed_filter_iter_flushes(tmp_path):
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    # iter and imiter must yield the buffered frames too
    iterated = np.stack(
        list(
            iio.imiter(
                in_path,
                plugin="pyav",
                filter_sequence=[("tpad", "start=3")],
            )
        )
    )
    bulk = iio.imread(in_path, plugin="pyav", filter_sequence=[("tpad", "start=3")])

    assert iterated.shape == bulk.shape
    assert np.allclose(iterated, bulk)
    assert iterated.shape[0] == expected.shape[0] + 3


def test_delayed_filter_write_flushes(tmp_path):
    in_path = tmp_path / "in.mp4"
    frames = _write_test_video(in_path)

    # `tpad` prepends frames; they must be flushed into the container on close
    out_path = tmp_path / "padded.mp4"
    iio.imwrite(
        out_path,
        frames,
        plugin="pyav",
        codec="mpeg4",
        fps=10,
        filter_sequence=[("tpad", "start=3")],
    )

    actual = iio.imread(out_path, plugin="pyav")
    assert actual.shape == (frames.shape[0] + 3,) + frames.shape[1:]
    assert actual.shape[0] == frames.shape[0] + 3


def test_delayed_filter_write_flushes_tail(tmp_path):
    in_path = tmp_path / "in.mp4"
    frames = _write_test_video(in_path)

    # `tpad stop=3` appends frames that only become available at flush time
    out_path = tmp_path / "padded_tail.mp4"
    iio.imwrite(
        out_path,
        frames,
        plugin="pyav",
        codec="mpeg4",
        fps=10,
        filter_sequence=[("tpad", "stop=3")],
    )

    actual = iio.imread(out_path, plugin="pyav")
    assert actual.shape[0] == frames.shape[0] + 3


def test_delayed_filter_write_drops_frames(tmp_path):
    in_path = tmp_path / "in.mp4"
    frames = _write_test_video(in_path)

    # `framestep` drops frames; the container must contain the remaining ones
    out_path = tmp_path / "stepped.mp4"
    iio.imwrite(
        out_path,
        frames,
        plugin="pyav",
        codec="mpeg4",
        fps=10,
        filter_sequence=[("framestep", "2")],
    )

    actual = iio.imread(out_path, plugin="pyav")
    assert actual.shape[0] == int(np.ceil(frames.shape[0] / 2))


def test_delayed_filter_write_bytes(tmp_path):
    in_path = tmp_path / "in.mp4"
    frames = _write_test_video(in_path)

    # writing to `<bytes>` flushes immediately; the returned bytes must contain
    # the padded frames as well
    encoded = iio.imwrite(
        "<bytes>",
        frames,
        extension=".mp4",
        plugin="pyav",
        codec="mpeg4",
        fps=10,
        filter_sequence=[("tpad", "start=3")],
    )

    assert isinstance(encoded, bytes)
    actual = iio.imread(encoded, plugin="pyav", extension=".mp4")
    assert actual.shape[0] == frames.shape[0] + 3


def test_delayed_filter_write_close_flushes(tmp_path):
    # the same as above, but using the procedural API and an explicit close
    in_path = tmp_path / "in.mp4"
    frames = _write_test_video(in_path)

    out_path = tmp_path / "procedural.mp4"
    with iio.imopen(out_path, "w", plugin="pyav", extension=".mp4") as file:
        file.init_video_stream("mpeg4", fps=10)
        file.set_video_filter(filter_sequence=[("tpad", "start=2")])
        for frame in frames:
            file.write_frame(frame)

    actual = iio.imread(out_path, plugin="pyav")
    assert actual.shape[0] == frames.shape[0] + 2


def test_no_filter_read_unchanged(tmp_path):
    # the fix must not alter the no-filter code path
    in_path = tmp_path / "in.mp4"
    expected = _write_test_video(in_path)

    assert np.allclose(iio.imread(in_path, plugin="pyav"), expected)

    with iio.imopen(in_path, "r", plugin="pyav") as file:
        for idx in range(expected.shape[0]):
            assert np.allclose(file.read(index=idx), expected[idx])
