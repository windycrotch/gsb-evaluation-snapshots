# WAV interchange

## Supported formats

The reader supports integer PCM at 8, 16, 24 and 32 bits, IEEE floating-point samples at 32 and 64 bits, and supported extensible PCM/float subformats. Eight-bit PCM is unsigned; wider PCM is signed little-endian. Non-finite float samples are rejected.

The RIFF scanner validates container and chunk sizes, odd-byte padding, duplicate required chunks and bounded chunk counts. PCM format fields must agree on channel count, block alignment and byte rate. Inputs are limited to 128 MB before sample-allocation checks.

`encodeWav` accepts `pcm8`, `pcm16`, `pcm24`, `pcm32`, `float32` or `float64`. Integer output clips to its representable range and quantizes. Floating output includes the fact chunk and sample count. The encoder does not compress audio.

Before allocating any output, `checkWavEncodable` validates an audio source without writing a single byte and returns a structured result. The `ok` outcome carries the sample rate, channel count, per-channel frame count and aggregate sample total so the workbench can confirm an export can proceed. A failed outcome names exactly one machine-readable reason: `invalid-sample-rate` (the rate is not an integer in 1–192000 Hz), `too-many-channels` (more than 32 channels), `sample-count-exceeded` (the aggregate sample count is above the 2^24 memory limit) or `non-finite-sample` (a NaN or Infinity, reported with its channel and index), plus a human-readable `message`. `encodeWav` runs the same check first and raises a `RangeError` before allocating its buffer, so rejected sources never leave half-written bytes behind.

For compressed browser files, the demo uses native browser decoding after duration and byte checks. The core WAV reader remains deterministic across browser and Node runtimes.
