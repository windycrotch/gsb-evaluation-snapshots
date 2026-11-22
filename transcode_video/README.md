# Transcode-Video

## Overview

This application is a command-line interface (CLI) tool designed for transcoding video files using NVIDIA GPUs. It leverages the PyCuda library and PyNvVIdeoCodec SDK to perform efficient video transcoding. The tool supports various input formats and can transcode videos to different output formats, resolutions, and bitrates, making use of the GPU's hardware-accelerated decoding and encoding capabilities This is particularly useful for developers, content creators, and researchers who need to convert videos into formats suitable for different devices or for further video processing tasks.

## Usage

To use the transcode tool, you need to specify the GPU ID, the path to the input video file, the path where the transcoded video file will be saved, and the encoding configuration parameters. The application is executed from the command line, providing an efficient way to transcode videos on systems equipped with NVIDIA GPUs.
The provided code snippet demonstrates the transcoding process, where the input video is decoded and then re-encoded according to the specified encoding configuration. The transcoding process involves decoding the video to raw frames and then encoding these frames into the target format. The tool prints out the width and height of the video for reference and keeps track of the number of frames processed. The transcoded output video is written to a unique temporary file first and atomically moved to the specified output path only after the whole stream has been encoded and flushed, so a failed run can never leave a half-written file behind.

## Configuration merge precedence

Encoding options can come from a JSON config file and from the command line at the same time. The merge rules are explicit:

1. The JSON config file provides the base options.
2. `--codec` / `-c` and `--preset` / `-p` given on the command line override the same-named JSON fields (codec is lower-cased, preset upper-cased).
3. Every other JSON field (e.g. `fps`, `gop`, `bitrate`, `rc`, `tuning_info`) is preserved unchanged.
4. When no JSON config is supplied, behavior matches the historical CLI: the config contains `codec` and `preset` only (an omitted `-p` becomes an empty preset string).

## Empty and un-decodable inputs

If the demuxer yields no packets, or the decoder never produces a frame, the encoder is never created and no flush is attempted. The program finishes normally (exit code 0, frame count 0) and leaves a valid, zero-length output file - a recognizable empty result rather than a crash or a truncated artifact.

## Output lifecycle and concurrent runs

- All encoded bytes, including the tail packets produced by the final encoder flush, are written to a per-process temporary file in the output directory.
- On success the temporary file is flushed, fsync'd, closed and atomically replaced onto the destination path (`os.replace`).
- On any failure (encoder creation, encoding, writing, finalization) the temporary file is closed and deleted and the destination path is left untouched; the CLI exits with code 1 and prints the error to stderr.
- Because each run stages into its own temp file and publication is atomic, two concurrent transcoding jobs targeting the same output path can never produce a file with two bitstreams interleaved: one complete file wins the replacement and the other either replaces it in turn or fails explicitly.

## Command Line Arguments
- `--gpu_id`: The ID of the GPU to use for transcoding. Default is 0.
- `--in_file_path`: The file path of the input video.
- `--out_file_path`: The file path where the transcoded video will be saved.
- `--codec`: The codec to use for encoding (e.g., h264, hevc, av1).
- `--preset`: The encoding preset to use (e.g., P1, P2, P3, P4, P5, P6, P7). Default is None.
- `--config_file`: path of json config file. Various encoding properties can be set via this config file like FPS, Bitrate. Default is None.

## Hardware backend and offline testing

Hardware access (demuxer, decoder, encoder, device-memory copies) is isolated behind the backend abstraction in `hw_backend.py`. The production backend (`nvc`, the default) imports `PyNvVideoCodec` and `pycuda` lazily and drives the real hardware. For machines without a GPU, the self-contained `stub` backend replaces every hardware call with a pure-Python implementation and reads simple JSON *stub container* inputs, so the entire pipeline - including the real `transcode()` entry point and the real argparse CLI - can be exercised offline.

Select the backend with the `TRANSCODE_BACKEND` environment variable (`nvc` or `stub`); the stub also honors `TRANSCODE_FAIL_ENCODER_CREATE` and `TRANSCODE_FAIL_ENCODE_AT_FRAME` for failure injection.

## Example
```bash
python3 transcode.py --gpu_id 0 --in_file_path ../assets/videos/pexels-chiel-slotman-4423925-1920x1080-25fps.mp4 --out_file_path output.h264 --codec "h264" --preset "P1" --config_file ../assets/configs/encode_config.json
```

Offline example with the stub backend (no GPU required):
```bash
TRANSCODE_BACKEND=stub python3 transcode.py -i sample.stub.json -o output.h264 -c h264 -p P1 -json ../assets/configs/encode_config.json
```

## Tests

The offline test suite covers normal multi-frame transcoding, empty inputs, mixed JSON/CLI configuration, mid-transcode failures (encoder creation and per-frame write errors), and two processes writing the same output path concurrently:

```bash
python3 -m pytest transcode_video/tests/ -v
```
