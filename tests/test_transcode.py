# Offline unit tests for the transcoding configuration merge and the
# encoder wrapper (common/nvcodec_utils.py + transcode_video/transcode.py).
#
# These tests run without a GPU, PyNvVideoCodec, pycuda or PyAV: fakes are
# injected through the factory hooks of transcode() and nvVideoEncoder.
#
# Run with:  python -m pytest tests/test_transcode.py
#        or:  python -m unittest tests.test_transcode

import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "transcode_video"))

import transcode  # noqa: E402
from common.nvcodec_utils import (  # noqa: E402
    merge_encoder_config,
    validate_encoder_config,
    nvVideoEncoder,
)


# --------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------

class FakeDemuxer:
    def __init__(self, packets, codec_id="h264", fps=30):
        self._packets = list(packets)
        self._codec_id = codec_id
        self._fps = fps

    def __iter__(self):
        return iter(self._packets)

    def GetNvCodecId(self):
        return self._codec_id

    def FrameRate(self):
        return self._fps


class FakeDecodedFrame:
    def __init__(self, index):
        self.index = index

    def GetPtrToPlane(self, plane):
        return 0x1000 + self.index  # fake device pointer


class FakeDecoder:
    """Decodes each packet into a fixed number of fake frames."""

    def __init__(self, frames_per_packet=2, width=64, height=64, **kwargs):
        self.frames_per_packet = frames_per_packet
        self._width = width
        self._height = height
        self._next = 0
        self.kwargs = kwargs

    def Decode(self, packet):
        frames = []
        for _ in range(self.frames_per_packet):
            frames.append(FakeDecodedFrame(self._next))
            self._next += 1
        return frames

    def GetWidth(self):
        return self._width

    def GetHeight(self):
        return self._height

    def GetFrameSize(self):
        return self._width * self._height * 3 // 2


class FakeEncoder:
    """Stands in for nvvc.CreateEncoder's product. Records every frame."""

    instances = []

    def __init__(self, width, height, fmt, verbose, **config):
        self.width = width
        self.height = height
        self.format = fmt
        self.config = config
        self.encoded_frames = []
        self.end_encode_calls = 0
        self.closed = False
        # Behavior toggles, set via class attributes by tests.
        self.tail_chunks = list(type(self).tail_chunks)
        self.fail_on_encode = type(self).fail_on_encode
        self.fail_on_end_encode = type(self).fail_on_end_encode
        FakeEncoder.instances.append(self)

    # Class-level behavior controls (reset in setUp).
    tail_chunks = [b"tail-1", b"tail-2"]
    fail_on_encode = None      # 1-based index of the Encode call that raises
    fail_on_end_encode = False

    def Encode(self, frame):
        if self.fail_on_encode is not None and \
                len(self.encoded_frames) + 1 == self.fail_on_encode:
            raise RuntimeError("injected encode failure")
        self.encoded_frames.append(frame)
        return bytes([0xAB, len(self.encoded_frames) & 0xFF])

    def EndEncode(self):
        self.end_encode_calls += 1
        if self.fail_on_end_encode:
            raise RuntimeError("injected flush failure")
        return list(self.tail_chunks)

    def close(self):
        self.closed = True


class FakePacket:
    def __init__(self, payload):
        self.payload = bytes(payload)
        self.pts = None
        self.dts = None
        self.stream = None
        self.time_base = None


class FakeStream:
    def __init__(self, codec, rate):
        self.codec = codec
        self.rate = rate
        self.width = None
        self.height = None
        self.time_base = None


class FakeContainer:
    def __init__(self, path, fail_on_mux=None):
        self.path = path
        self.packets = []
        self.streams = []
        self.closed = False
        self.fail_on_mux = fail_on_mux

    def add_stream(self, codec, rate=None):
        stream = FakeStream(codec, rate)
        self.streams.append(stream)
        return stream

    def mux(self, pkt):
        if self.fail_on_mux is not None and \
                len(self.packets) + 1 == self.fail_on_mux:
            raise RuntimeError("injected mux failure")
        self.packets.append(pkt)

    def close(self):
        self.closed = True


class FakeFrame:
    def __init__(self, index):
        self.gpuAlloc = 0x2000 + index


def make_frame_pool(width, height, fmt, count):
    return [FakeFrame(i) for i in range(count)]


def fake_frame_copier(dst, src, size):
    pass


class TranscodeTestBase(unittest.TestCase):
    def setUp(self):
        FakeEncoder.instances = []
        FakeEncoder.tail_chunks = [b"tail-1", b"tail-2"]
        FakeEncoder.fail_on_encode = None
        FakeEncoder.fail_on_end_encode = False
        self.containers = []
        self.tmp = Path(self.id().split(".")[-1] + "_tmp")
        self.tmp.mkdir(exist_ok=True)
        self.out_file = self.tmp / "out.mp4"

    def tearDown(self):
        for child in self.tmp.iterdir():
            child.unlink()
        self.tmp.rmdir()

    def container_factory(self, path, fail_on_mux=None):
        # Like av.open(path, "w"), the factory creates the output file.
        Path(path).touch()
        container = FakeContainer(path, fail_on_mux=fail_on_mux)
        self.containers.append(container)
        return container

    def run_transcode(self, config=None, packets=3, frames_per_packet=2,
                      out_file=None, fail_on_mux=None):
        config = config or {"codec": "h264", "preset": "P3",
                            "bitrate": "2M", "tuning": "hq"}
        demuxer = FakeDemuxer([b"pkt"] * packets)
        decoder = FakeDecoder(frames_per_packet=frames_per_packet)
        out_file = out_file or self.out_file
        frame_count = transcode.transcode(
            0,
            "fake_input.mp4",
            str(out_file),
            config,
            demuxer_factory=lambda filename: demuxer,
            decoder_factory=lambda **kwargs: decoder,
            encoder_factory=FakeEncoder,
            container_factory=lambda path: self.container_factory(
                path, fail_on_mux=fail_on_mux),
            packet_factory=FakePacket,
            frame_pool_factory=make_frame_pool,
            frame_copier=fake_frame_copier,
        )
        return frame_count


# --------------------------------------------------------------------------
# Configuration merging / validation
# --------------------------------------------------------------------------

class TestConfigMerge(unittest.TestCase):
    def test_cli_codec_and_preset_override_json(self):
        merged = merge_encoder_config(
            {"codec": "hevc", "preset": "P1", "bitrate": "5M"},
            codec="h264", preset="P7")
        self.assertEqual(merged["codec"], "h264")
        self.assertEqual(merged["preset"], "P7")

    def test_other_json_keys_are_preserved(self):
        merged = merge_encoder_config(
            {"codec": "hevc", "bitrate": "5M", "tuning": "hq", "gop": 30},
            codec="av1", preset="P2")
        self.assertEqual(merged["bitrate"], "5M")
        self.assertEqual(merged["tuning"], "hq")
        self.assertEqual(merged["gop"], 30)

    def test_json_values_used_when_cli_absent(self):
        merged = merge_encoder_config(
            {"codec": "hevc", "preset": "P6"}, codec=None, preset=None)
        self.assertEqual(merged["codec"], "hevc")
        self.assertEqual(merged["preset"], "P6")

    def test_normalization_codec_lower_preset_upper(self):
        merged = merge_encoder_config(
            {"codec": "HEVC", "preset": "p3"}, codec=None, preset=None)
        self.assertEqual(merged["codec"], "hevc")
        self.assertEqual(merged["preset"], "P3")
        merged = merge_encoder_config({}, codec="H264", preset="p1")
        self.assertEqual(merged["codec"], "h264")
        self.assertEqual(merged["preset"], "P1")

    def test_validate_rejects_bad_codec(self):
        with self.assertRaises(ValueError):
            validate_encoder_config({"codec": "vp9", "preset": "P1"})

    def test_validate_rejects_bad_preset(self):
        with self.assertRaises(ValueError):
            validate_encoder_config({"codec": "h264", "preset": "P9"})

    def test_validate_rejects_missing_codec(self):
        with self.assertRaises(ValueError):
            validate_encoder_config({"preset": "P1"})

    def test_validate_accepts_all_supported(self):
        for codec in ("h264", "hevc", "av1"):
            for preset in ("P1", "P4", "P7"):
                validate_encoder_config({"codec": codec, "preset": preset})


# --------------------------------------------------------------------------
# Validation happens before the output file is created
# --------------------------------------------------------------------------

class TestValidationBeforeOutput(TranscodeTestBase):
    def test_invalid_codec_fails_before_creating_output(self):
        with self.assertRaises(ValueError):
            self.run_transcode(config={"codec": "vp9", "preset": "P1"})
        self.assertFalse(self.out_file.exists())
        self.assertEqual(FakeEncoder.instances, [])
        self.assertEqual(self.containers, [])

    def test_invalid_preset_fails_before_creating_output(self):
        with self.assertRaises(ValueError):
            self.run_transcode(config={"codec": "h264", "preset": "P0"})
        self.assertFalse(self.out_file.exists())
        self.assertEqual(FakeEncoder.instances, [])


# --------------------------------------------------------------------------
# Normal path: order, tail frames, timestamps
# --------------------------------------------------------------------------

class TestNormalTranscode(TranscodeTestBase):
    def test_all_frames_written_in_order_with_tail_and_monotonic_pts(self):
        frame_count = self.run_transcode(packets=3, frames_per_packet=2)
        self.assertEqual(frame_count, 6)

        self.assertEqual(len(FakeEncoder.instances), 1)
        encoder = FakeEncoder.instances[0]
        self.assertEqual(len(encoder.encoded_frames), 6)
        self.assertEqual(encoder.end_encode_calls, 1)

        container = self.containers[0]
        # 6 frame packets + 2 tail packets, in arrival order.
        self.assertEqual(len(container.packets), 8)
        pts = [pkt.pts for pkt in container.packets]
        self.assertEqual(pts, list(range(8)))  # strictly increasing from 0
        dts = [pkt.dts for pkt in container.packets]
        self.assertEqual(dts, pts)
        # Tail frames come last, exactly once each.
        payloads = [pkt.payload for pkt in container.packets]
        self.assertEqual(payloads[-2:], [b"tail-1", b"tail-2"])
        self.assertEqual(payloads.count(b"tail-1"), 1)
        self.assertEqual(payloads.count(b"tail-2"), 1)

        self.assertTrue(container.closed)
        self.assertTrue(self.out_file.exists())

    def test_full_config_forwarded_to_encoder(self):
        self.run_transcode(config={"codec": "hevc", "preset": "P5",
                                   "bitrate": "4M", "tuning": "ll"})
        encoder = FakeEncoder.instances[0]
        self.assertEqual(encoder.config["codec"], "hevc")
        self.assertEqual(encoder.config["preset"], "P5")
        self.assertEqual(encoder.config["bitrate"], "4M")
        self.assertEqual(encoder.config["tuning"], "ll")
        # The muxed stream uses the codec from the same effective config.
        self.assertEqual(self.containers[0].streams[0].codec, "hevc")

    def test_empty_input_raises_without_output(self):
        with self.assertRaises(RuntimeError):
            self.run_transcode(packets=0)
        self.assertFalse(self.out_file.exists())
        self.assertEqual(FakeEncoder.instances, [])


# --------------------------------------------------------------------------
# Flush behavior of the encoder wrapper
# --------------------------------------------------------------------------

class TestFlush(TranscodeTestBase):
    def make_encoder(self, **kwargs):
        out = self.tmp / "direct.mp4"
        return nvVideoEncoder(
            0, 64, 64, 30, str(out),
            cuda_ctx=None, cuda_stream=None, format="NV12",
            encoder_config={"codec": "h264", "preset": "P4"},
            encoder_factory=FakeEncoder,
            container_factory=lambda path: self.container_factory(path),
            packet_factory=FakePacket,
            **kwargs,
        )

    def test_flush_is_idempotent(self):
        encoder = self.make_encoder()
        encoder.encode_from_tensor(object())
        encoder.flush()
        encoder.flush()  # must not duplicate tail packets
        container = self.containers[0]
        self.assertEqual(len(container.packets), 3)  # 1 frame + 2 tail
        payloads = [pkt.payload for pkt in container.packets]
        self.assertEqual(payloads.count(b"tail-1"), 1)
        self.assertEqual(FakeEncoder.instances[0].end_encode_calls, 1)

    def test_flush_with_single_blob_tail(self):
        FakeEncoder.tail_chunks = []
        encoder = self.make_encoder()
        # EndEncode returning one bytes blob instead of a list.
        FakeEncoder.instances  # noqa: B018 - keep symmetry, no-op
        encoder.encode_from_tensor(object())
        fake = FakeEncoder.instances[0]
        fake.tail_chunks = []
        original_end = fake.EndEncode
        fake.EndEncode = lambda: b"single-tail-blob"
        encoder.flush()
        payloads = [pkt.payload for pkt in self.containers[0].packets]
        self.assertIn(b"single-tail-blob", payloads)
        fake.EndEncode = original_end

    def test_empty_encode_output_is_not_muxed(self):
        encoder = self.make_encoder()
        fake = FakeEncoder.instances[0]
        fake.Encode = lambda frame: b""  # encoder buffering, no output yet
        encoder.encode_from_tensor(object())
        self.assertEqual(len(self.containers[0].packets), 0)
        self.assertEqual(encoder.pts_time, 1)  # pts still advances


# --------------------------------------------------------------------------
# Exception cleanup
# --------------------------------------------------------------------------

class TestExceptionCleanup(TranscodeTestBase):
    def test_encode_failure_cleans_up_and_reraises(self):
        FakeEncoder.fail_on_encode = 3
        with self.assertRaisesRegex(RuntimeError, "injected encode failure"):
            self.run_transcode(packets=3, frames_per_packet=2)
        # Container closed, encoder released, partial output deleted.
        self.assertTrue(self.containers[0].closed)
        encoder = FakeEncoder.instances[0]
        self.assertTrue(encoder.closed)
        self.assertFalse(self.out_file.exists())

    def test_mux_failure_cleans_up_and_reraises(self):
        with self.assertRaisesRegex(RuntimeError, "injected mux failure"):
            self.run_transcode(packets=3, frames_per_packet=2, fail_on_mux=2)
        self.assertTrue(self.containers[0].closed)
        self.assertFalse(self.out_file.exists())

    def test_flush_failure_cleans_up_and_reraises(self):
        FakeEncoder.fail_on_end_encode = True
        with self.assertRaisesRegex(RuntimeError, "injected flush failure"):
            self.run_transcode(packets=2, frames_per_packet=1)
        self.assertTrue(self.containers[0].closed)
        self.assertFalse(self.out_file.exists())

    def test_decode_failure_midstream_cleans_up(self):
        decoder = FakeDecoder(frames_per_packet=1)

        def exploding_decode(packet):
            if decoder._next >= 2:
                raise RuntimeError("injected decode failure")
            return FakeDecoder.Decode(decoder, packet)

        decoder.Decode = exploding_decode
        demuxer = FakeDemuxer([b"pkt"] * 5)
        with self.assertRaisesRegex(RuntimeError, "injected decode failure"):
            transcode.transcode(
                0, "fake_input.mp4", str(self.out_file),
                {"codec": "h264", "preset": "P1"},
                demuxer_factory=lambda filename: demuxer,
                decoder_factory=lambda **kwargs: decoder,
                encoder_factory=FakeEncoder,
                container_factory=self.container_factory,
                packet_factory=FakePacket,
                frame_pool_factory=make_frame_pool,
                frame_copier=fake_frame_copier,
            )
        self.assertTrue(self.containers[0].closed)
        self.assertFalse(self.out_file.exists())


# --------------------------------------------------------------------------
# Repeated transcoding in the same process
# --------------------------------------------------------------------------

class TestRepeatTranscode(TranscodeTestBase):
    def test_second_run_does_not_reuse_state(self):
        out1 = self.tmp / "out1.mp4"
        out2 = self.tmp / "out2.mp4"
        count1 = self.run_transcode(packets=3, frames_per_packet=2,
                                    out_file=out1)
        count2 = self.run_transcode(packets=3, frames_per_packet=2,
                                    out_file=out2)
        self.assertEqual(count1, count2)

        # Two independent encoder instances were created.
        self.assertEqual(len(FakeEncoder.instances), 2)
        self.assertIsNot(FakeEncoder.instances[0], FakeEncoder.instances[1])

        # Each output has its own timestamps starting at 0, strictly
        # increasing, with the same number of packets.
        pts1 = [pkt.pts for pkt in self.containers[0].packets]
        pts2 = [pkt.pts for pkt in self.containers[1].packets]
        self.assertEqual(pts1, pts2)
        self.assertEqual(pts2, list(range(len(pts2))))
        self.assertEqual(len(pts1), count1 + 2)  # frames + tail

        # Both outputs exist independently and are closed properly.
        self.assertTrue(out1.exists())
        self.assertTrue(out2.exists())
        self.assertTrue(self.containers[0].closed)
        self.assertTrue(self.containers[1].closed)

    def test_different_configs_do_not_pollute_each_other(self):
        out1 = self.tmp / "cfg_a.mp4"
        out2 = self.tmp / "cfg_b.mp4"
        self.run_transcode(config={"codec": "h264", "preset": "P1",
                                   "bitrate": "1M"},
                           out_file=out1)
        self.run_transcode(config={"codec": "hevc", "preset": "P7",
                                   "bitrate": "8M"},
                           out_file=out2)
        enc_a, enc_b = FakeEncoder.instances
        self.assertEqual(enc_a.config["codec"], "h264")
        self.assertEqual(enc_a.config["preset"], "P1")
        self.assertEqual(enc_a.config["bitrate"], "1M")
        self.assertEqual(enc_b.config["codec"], "hevc")
        self.assertEqual(enc_b.config["preset"], "P7")
        self.assertEqual(enc_b.config["bitrate"], "8M")
        self.assertEqual(self.containers[0].streams[0].codec, "h264")
        self.assertEqual(self.containers[1].streams[0].codec, "hevc")


if __name__ == "__main__":
    unittest.main()
