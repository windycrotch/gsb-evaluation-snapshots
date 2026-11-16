# Changelog

## Unreleased

- Add `checkWavEncodable`, a pre-flight WAV validation entry that reports a structured result distinguishing invalid sample rate, channel counts above 32, aggregate sample counts beyond the memory limit and non-finite samples before any byte is written.
- Guard `encodeWav` with the same pre-flight check so NaN/Infinity samples raise a `RangeError` before buffer allocation, never leaving half-written output.

## 0.1.1

- Complete browser workbench with waveform, spectrum, logarithmic spectrogram, frame inspection, playback, microphone capture and local exports.
- Add integer and floating-point WAV interchange, exact waveform peak queries and bounded incremental analysis.
- Correct mel conversion, triangular-window geometry, inverse STFT normalization, downsampling filtering and symmetric input validation.
- Verify numerical properties, every public runtime export, strict test types and executable examples.

## 0.1.0

- Establish the TypeScript DSP core, planar audio buffers, signal generators and initial transforms.
