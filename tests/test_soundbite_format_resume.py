"""
Tests for per-format resumable rendering of soundbite audiograms.

A soundbite renders one MP4 per enabled format. These tests cover:
- a partially failed soundbite re-run only re-renders the missing/failed
  formats (completed formats are not re-encoded),
- --force re-renders every enabled format even if outputs already exist,
- a render that fails midway leaves no partial MP4 that a later run would
  mistake for a completed format.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

from audiogram_generator import pipeline


def _make_selected(n_soundbites=1):
    return {
        'number': 20,
        'title': 'Episode 20',
        'link': 'https://example.com/ep20',
        'audio_url': 'https://example.com/ep20.mp3',
        'transcript_url': None,
        'soundbites': [
            {'start': i * 10, 'duration': 5, 'title': f'SB{i}', 'text': f'text{i}'}
            for i in range(1, n_soundbites + 1)
        ],
        'keywords': '',
        'image_url': None,
    }


FORMATS_CONFIG = {
    'vertical': {'width': 64, 'height': 128, 'enabled': True},
    'square': {'width': 64, 'height': 64, 'enabled': True},
}


def _rendered_formats(mock_generate):
    """Return the list of format names generate_audiogram was called with."""
    return [call.args[2] for call in mock_generate.call_args_list]


class TestPerFormatResume(unittest.TestCase):
    def _run_soundbite(self, tmp, selected, force=False):
        return pipeline._process_single_soundbite(
            soundbite=selected['soundbites'][0],
            soundbite_num=1,
            total_soundbites=None,
            selected=selected,
            podcast_info={'title': 'Podcast', 'image_url': None},
            temp_dir=tmp,
            logo_path=os.path.join(tmp, 'logo.png'),
            srt_content=None,
            full_audio_path=self.full_audio_path,
            output_dir=tmp,
            formats_config=FORMATS_CONFIG,
            colors={},
            show_subtitles=False,
            config_hashtags=None,
            force=force,
        )

    def _mp4_path(self, tmp, fmt):
        return os.path.join(tmp, 'sb1', f"ep20_sb1_nosubs_{fmt}.mp4")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = self._tmp.name

        # A real full-audio file so the pipeline attempts segment extraction.
        self.full_audio_path = os.path.join(tmp, 'full.mp3')
        with open(self.full_audio_path, 'wb') as f:
            f.write(b'audio')

        # extract_audio_segment writes the segment file it is asked for.
        def fake_extract(_full, _start, _dur, segment_path, audio=None):
            with open(segment_path, 'wb') as f:
                f.write(b'segment')

        extract_patcher = patch(
            'audiogram_generator.pipeline.extract_audio_segment',
            side_effect=fake_extract,
        )
        self.mock_extract = extract_patcher.start()
        self.addCleanup(extract_patcher.stop)

        generate_patcher = patch('audiogram_generator.pipeline.generate_audiogram')
        self.mock_generate = generate_patcher.start()
        self.addCleanup(generate_patcher.stop)

    def _succeed_all(self, _audio, output_path, _fmt, *args, **kwargs):
        with open(output_path, 'wb') as f:
            f.write(b'mp4')

    def test_rerun_only_renders_missing_formats(self):
        """After square fails and vertical succeeds, a re-run renders only square."""
        selected = _make_selected()
        tmp = self._tmp.name

        def fail_square(_audio, output_path, format_name, *args, **kwargs):
            if format_name == 'square':
                raise RuntimeError('encoder exploded')
            with open(output_path, 'wb') as f:
                f.write(b'mp4')

        self.mock_generate.side_effect = fail_square
        with self.assertLogs('audiogram_generator.pipeline', level='ERROR') as logs:
            with self.assertRaises(RuntimeError):
                self._run_soundbite(tmp, selected)

        # The failure log must name both the soundbite and the failed format.
        self.assertTrue(
            any("Soundbite 1" in line and "square" in line for line in logs.output),
            f"expected a log line naming soundbite and format, got: {logs.output}",
        )

        # First run: both formats attempted; vertical landed on disk, square did not.
        self.assertEqual(sorted(_rendered_formats(self.mock_generate)),
                         ['square', 'vertical'])
        self.assertTrue(os.path.exists(self._mp4_path(tmp, 'vertical')))
        self.assertFalse(os.path.exists(self._mp4_path(tmp, 'square')))

        # Second run without --force: only the missing format is re-rendered.
        self.mock_generate.reset_mock()
        self.mock_generate.side_effect = self._succeed_all
        result = self._run_soundbite(tmp, selected)

        self.assertEqual(_rendered_formats(self.mock_generate), ['square'])
        self.assertTrue(os.path.exists(self._mp4_path(tmp, 'square')))
        self.assertEqual(set(result), {'vertical', 'square'})

        # Third run: everything complete — nothing is re-encoded.
        self.mock_generate.reset_mock()
        self._run_soundbite(tmp, selected)
        self.mock_generate.assert_not_called()

    def test_force_renders_all_formats(self):
        """--force re-renders every enabled format even when outputs exist."""
        selected = _make_selected()
        tmp = self._tmp.name

        self.mock_generate.side_effect = self._succeed_all
        self._run_soundbite(tmp, selected)
        self.assertEqual(sorted(_rendered_formats(self.mock_generate)),
                         ['square', 'vertical'])

        self.mock_generate.reset_mock()
        self._run_soundbite(tmp, selected, force=True)
        self.assertEqual(sorted(_rendered_formats(self.mock_generate)),
                         ['square', 'vertical'])

    def test_partial_output_not_counted_as_complete(self):
        """A render that fails midway must not leave a partial MP4 behind."""
        selected = _make_selected()
        tmp = self._tmp.name

        def fail_midway(_audio, output_path, format_name, *args, **kwargs):
            if format_name == 'square':
                # Simulate an encoder that dies after writing a partial file.
                with open(output_path, 'wb') as f:
                    f.write(b'half-an-mp4')
                raise RuntimeError('encoder died mid-render')
            with open(output_path, 'wb') as f:
                f.write(b'mp4')

        self.mock_generate.side_effect = fail_midway
        with self.assertRaises(RuntimeError):
            self._run_soundbite(tmp, selected)

        # The partial file must have been cleaned up, not left as a fake success.
        self.assertFalse(os.path.exists(self._mp4_path(tmp, 'square')))
        self.assertTrue(os.path.exists(self._mp4_path(tmp, 'vertical')))

        # A re-run must re-attempt the failed format rather than skip it.
        self.mock_generate.reset_mock()
        self.mock_generate.side_effect = self._succeed_all
        self._run_soundbite(tmp, selected)
        self.assertEqual(_rendered_formats(self.mock_generate), ['square'])
        self.assertTrue(os.path.exists(self._mp4_path(tmp, 'square')))


if __name__ == '__main__':
    unittest.main()
