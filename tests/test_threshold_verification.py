"""Threshold skipping and encoded-output verification in batch workflows.

These tests cover the end-to-end chain a batch user needs to trust:

* files already within ``--threshold`` of the target are copied through and
  reported as ``skipped`` for EBU, RMS and peak normalization,
* files outside the threshold are still normalized,
* skipped files do not shift the shared batch gain reference, and the
  remaining files keep a common gain,
* a failed verification marks that file, yields a non-zero exit code and does
  not stop the other files,
* a dry run says verification was skipped instead of pretending it passed.
"""

import array
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import pytest


def write_tone(path: Path, peak_db: float) -> None:
    """Write a one-second mono tone with a known sample peak."""
    amplitude = 32767 * 10 ** (peak_db / 20)
    samples = array.array(
        "h", (round(amplitude * math.sin(2 * math.pi * i / 48)) for i in range(48000))
    )
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, 48000, 0, "NONE", "not compressed"))
        output.writeframes(samples.tobytes())


def run_cli(*arguments):
    return subprocess.run(
        [sys.executable, "-m", "ffmpeg_normalize", *map(str, arguments)],
        capture_output=True,
        text=True,
    )


# Measured levels of tests/test.m4a: -22.53 LUFS, -25.63 dBFS RMS,
# -17.39 dBFS sample peak. Each case sets a target close to the measured
# level (skip) or far away (normalize) for the matching quantity.
@pytest.mark.parametrize(
    "mode,within_target,outside_target",
    [
        ("ebu", -22.5, -18),
        ("rms", -25.6, -18),
        ("peak", -17.4, -10),
    ],
)
def test_threshold_skips_within_and_normalizes_outside(
    tmp_path, mode, within_target, outside_target
):
    source = tmp_path / "input.m4a"
    source.write_bytes(Path("tests/test.m4a").read_bytes())

    skipped_output = tmp_path / f"skipped.{mode}.m4a"
    skipped = run_cli(
        source,
        "-nt",
        mode,
        "-t",
        within_target,
        "--threshold",
        "1",
        "-c:a",
        "aac",
        "-o",
        skipped_output,
        "--print-stats",
    )
    assert skipped.returncode == 0, skipped.stderr
    (skipped_stats,) = json.loads(skipped.stdout)
    assert skipped_stats["status"] == "skipped"
    # A skipped file is copied through verbatim.
    assert skipped_output.read_bytes() == source.read_bytes()

    normalized_output = tmp_path / f"normalized.{mode}.m4a"
    normalized = run_cli(
        source,
        "-nt",
        mode,
        "-t",
        outside_target,
        "--threshold",
        "1",
        "-c:a",
        "aac",
        "-o",
        normalized_output,
        "--print-stats",
    )
    assert normalized.returncode == 0, normalized.stderr
    (normalized_stats,) = json.loads(normalized.stdout)
    assert normalized_stats["status"] == "normalized"
    assert normalized_output.read_bytes() != source.read_bytes()


@pytest.mark.parametrize("mode", ["ebu", "rms", "peak"])
def test_skipped_files_have_unchanged_levels_and_zero_gain(tmp_path, mode):
    """The summary must show skipped files as unchanged, with zero gain."""
    targets = {"ebu": -22.5, "rms": -25.6, "peak": -17.4}
    result = run_cli(
        "tests/test.m4a",
        "-nt",
        mode,
        "-t",
        targets[mode],
        "--threshold",
        "1",
        "-c:a",
        "aac",
        "-o",
        tmp_path / "out.m4a",
        "--print-summary",
    )
    assert result.returncode == 0, result.stderr
    table = result.stderr.split("Summary (", 1)[1]
    row = next(
        line.split() for line in table.splitlines() if line.startswith("tests/test.m4a")
    )
    # File, Stream, input, output, [peak for ebu|rms], gain, status
    assert row[-1] == "skipped"
    assert row[2] == row[3]
    assert row[-2] == "+0.0"


@pytest.mark.parametrize(
    "mode,target",
    [
        # A -20 dBFS sine tone measures -23.05 LUFS (EBU), -23.01 dBFS RMS and
        # -20 dBFS peak, so each mode gets a target that tone sits on.
        ("ebu", -23),
        ("rms", -23),
        ("peak", -20),
    ],
)
def test_batch_skipped_files_do_not_shift_reference(tmp_path, mode, target):
    """Skipped album tracks are excluded from the shared gain reference, and
    the remaining tracks get the gain they would get on their own."""
    # Two tracks at the target (skipped) and two far from it (normalized).
    levels = [-20.0, -20.0, -26.0, -26.0]
    inputs = []
    for index, level in enumerate(levels):
        source = tmp_path / f"input{index}.wav"
        write_tone(source, level)
        inputs.append(source)

    def batch_run(files, prefix):
        outputs = [tmp_path / f"{prefix}{index}.wav" for index in range(len(files))]
        result = run_cli(
            *files,
            "-o",
            *outputs,
            "-nt",
            mode,
            "-t",
            target,
            "--threshold",
            "0.5",
            "--batch",
            "--print-summary",
            "--print-stats",
            "--force",
        )
        assert result.returncode == 0, result.stderr
        rows = [
            line.split()
            for line in result.stderr.split("Summary (", 1)[1].splitlines()
            if line.startswith(str(tmp_path))
        ]
        return rows

    rows = batch_run(inputs, "together")
    statuses = [row[-1] for row in rows]
    assert statuses.count("skipped") == 2
    assert statuses.count("normalized") == 2

    # Skipped tracks are unchanged and carry a zero gain.
    for row, status in zip(rows, statuses):
        if status == "skipped":
            assert row[2] == row[3]
            assert row[-2] == "+0.0"

    # The two remaining tracks are normalized with one shared gain, and that
    # gain is the same as when they form the album on their own: the skipped
    # tracks did not shift the reference.
    together_gains = {
        row[-2] for row, status in zip(rows, statuses) if status == "normalized"
    }
    assert len(together_gains) == 1, rows

    alone_rows = batch_run(inputs[2:], "alone")
    assert [row[-1] for row in alone_rows] == ["normalized", "normalized"]
    assert {row[-2] for row in alone_rows} == together_gains


def test_failed_verification_is_per_file_and_keeps_others(tmp_path):
    """A stream whose encoded level misses the tolerance is marked as failed
    while the rest of the batch is still processed, and the exit code is
    non-zero."""
    inputs = []
    for index, peak in enumerate([-6, -12]):
        source = tmp_path / f"input{index}.wav"
        write_tone(source, peak)
        inputs.append(source)

    outputs = [tmp_path / f"output{index}.wav" for index in range(2)]
    result = run_cli(
        *inputs,
        "-o",
        *outputs,
        "-nt",
        "rms",
        "-t",
        "-23",
        # Shifting the post-filter level makes the effective output level
        # deviate from the expected -23 dBFS by far more than the tolerance.
        "-pof",
        "volume=-6dB",
        "--verify",
        "--print-stats",
        "--print-summary",
        "--force",
    )
    assert result.returncode == 1
    stats = json.loads(result.stdout)
    assert len(stats) == 2
    for entry in stats:
        assert entry["status"] == "error"
        assert entry["verification"]["passed"] is False
        assert "Encoded-output verification failed" in entry["error"]
    # Both encoded files exist: the second file was not abandoned after the
    # first verification failure.
    assert all(output.is_file() for output in outputs)
    assert "FAILED" in result.stderr


def test_verification_failure_does_not_stop_later_files(tmp_path):
    """A file that fails verification is recorded as failed, and the file
    processed after it is still normalized and verified successfully."""
    failing = tmp_path / "first.wav"
    later = tmp_path / "later.wav"
    write_tone(failing, -20)
    write_tone(later, -6)

    # The AAC output (.m4a) of the first file overshoots the peak target and
    # fails verification; the PCM output (.wav) of the second file hits its
    # target exactly.
    result = run_cli(
        failing,
        later,
        "-o",
        tmp_path / "first.m4a",
        tmp_path / "later.wav",
        "-nt",
        "peak",
        "-t",
        "-15",
        "--verify",
        "--print-stats",
        "--force",
    )
    stats = json.loads(result.stdout)
    assert result.returncode == 1
    first, second = stats
    assert first["status"] == "error"
    assert first["verification"]["passed"] is False
    assert second["status"] == "normalized"
    assert second["verification"]["passed"] is True
    assert (tmp_path / "first.m4a").is_file()
    assert (tmp_path / "later.wav").is_file()


def test_dry_run_reports_verification_skipped(tmp_path):
    destination = tmp_path / "output.wav"
    result = run_cli(
        "tests/test_quiet.m4a",
        "-o",
        destination,
        "--verify",
        "--threshold",
        "0.5",
        "-nt",
        "peak",
        "-t",
        "-22.5",
        "-n",
        "--print-summary",
        "--print-stats",
    )
    assert result.returncode == 0, result.stderr
    assert not destination.exists()
    # Dry run must not pretend verification passed.
    (stats,) = json.loads(result.stdout)
    assert "verification" not in stats
    assert "verification skipped" in result.stderr.lower()
    assert "dry run" in result.stderr
