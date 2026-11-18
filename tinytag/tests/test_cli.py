# SPDX-FileCopyrightText: 2020-2024 tinytag Contributors
# SPDX-License-Identifier: MIT

# pylint: disable=missing-class-docstring,missing-function-docstring
# pylint: disable=missing-module-docstring
# pyright: reportPrivateUsage=false

from __future__ import annotations

import json
import os
import sys

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from subprocess import check_output, CalledProcessError, STDOUT, run
from sys import executable
from tempfile import NamedTemporaryFile
from unittest import TestCase

from tinytag.__main__ import _run

PROJECT_FOLDER = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
SAMPLE_FOLDER = os.path.join(PROJECT_FOLDER, 'tinytag', 'tests', 'samples')
MP3_WITH_IMG = os.path.join(SAMPLE_FOLDER, 'image-text-encoding.mp3')
VALID_MP3 = os.path.join(SAMPLE_FOLDER, 'cbr.mp3')
CORRUPT_OGG = os.path.join(SAMPLE_FOLDER, 'invalid_file.ogg')
BOGUS_FILE = os.path.join(SAMPLE_FOLDER, 'there_is_no_such_ext.bogus')
TINYTAG_ATTRIBUTES = {
    'album', 'albumartist', 'artist', 'bitdepth', 'bitrate',
    'channels', 'comment', 'composer', 'disc', 'disc_total', 'duration',
    'filesize', 'filename', 'genre', 'is_lossless', 'mime_type', 'samplerate',
    'title', 'track', 'track_total', 'year'
}


class TestCLI(TestCase):

    @staticmethod
    def run_cli(args: str) -> str:
        debug_env = str(os.environ.pop("TINYTAG_DEBUG", None))
        output = check_output(
            f'{executable} -m tinytag ' + args, cwd=PROJECT_FOLDER,
            shell=True, stderr=STDOUT)
        if debug_env:
            os.environ["TINYTAG_DEBUG"] = debug_env
        return output.decode('utf-8')

    @staticmethod
    def run_cli_process(args: list[str]) -> tuple[int, str, str]:
        completed = run(
            [executable, '-m', 'tinytag'] + args,
            cwd=PROJECT_FOLDER, capture_output=True, text=True, check=False)
        return completed.returncode, completed.stdout, completed.stderr

    @staticmethod
    def run_in_process(argv: list[str]) -> tuple[int, str, str]:
        stdout: StringIO = StringIO()
        stderr: StringIO = StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            returncode: int = _run(argv)
        return returncode, stdout.getvalue(), stderr.getvalue()

    def test_wrong_params(self) -> None:
        with self.assertRaises(CalledProcessError) as excinfo:
            self.run_cli('-lol')
        output = excinfo.exception.stdout.strip()
        self.assertEqual(
            output, b"-lol: [Errno 2] No such file or directory: '-lol'")

    def test_print_help(self) -> None:
        self.assertIn('tinytag [options] <filename', self.run_cli('-h'))
        self.assertIn('tinytag [options] <filename', self.run_cli('--help'))

    def test_save_image_long_opt(self) -> None:
        with NamedTemporaryFile() as temp_file:
            self.assertEqual(os.path.getsize(temp_file.name), 0)
        self.run_cli(f'--save-image {temp_file.name} {MP3_WITH_IMG}')
        self.assertGreater(os.path.getsize(temp_file.name), 0)
        with open(temp_file.name, 'rb') as file_handle:
            image_data = file_handle.read(20)
            self.assertTrue(image_data.startswith(b'\xff'))
            self.assertIn(b'JFIF', image_data)

    def test_save_image_short_opt(self) -> None:
        with NamedTemporaryFile() as temp_file:
            self.assertEqual(os.path.getsize(temp_file.name), 0)
        self.run_cli(f'-i {temp_file.name} {MP3_WITH_IMG}')
        self.assertGreater(os.path.getsize(temp_file.name), 0)

    def test_save_image_bulk(self) -> None:
        temp_name = None
        with NamedTemporaryFile(suffix='.jpg') as temp_file:
            temp_name = temp_file.name
            temp_name_no_ext = temp_name[:-4]
            self.assertEqual(os.path.getsize(temp_name), 0)
        self.run_cli(
            f'-i {temp_name} {MP3_WITH_IMG} {MP3_WITH_IMG} {MP3_WITH_IMG}')
        self.assertFalse(os.path.isfile(temp_name))
        self.assertGreater(os.path.getsize(temp_name_no_ext + '00000.jpg'), 0)
        self.assertGreater(os.path.getsize(temp_name_no_ext + '00001.jpg'), 0)
        self.assertGreater(os.path.getsize(temp_name_no_ext + '00002.jpg'), 0)

    def test_meta_data_output_default_json(self) -> None:
        output = self.run_cli(MP3_WITH_IMG)
        data = json.loads(output)
        self.assertTrue(data)
        self.assertTrue(set(data.keys()).issubset(TINYTAG_ATTRIBUTES))

    def test_meta_data_output_format_json(self) -> None:
        output = self.run_cli('-f json ' + MP3_WITH_IMG)
        data = json.loads(output)
        self.assertTrue(data)
        self.assertTrue(set(data.keys()).issubset(TINYTAG_ATTRIBUTES))

    def test_meta_data_output_format_csv(self) -> None:
        output = self.run_cli('-f csv ' + MP3_WITH_IMG)
        lines = [line for line in output.split(os.linesep) if line]
        self.assertTrue(all(',' in line for line in lines))
        attributes = set(line.split(',')[0] for line in lines)
        self.assertTrue(set(attributes).issubset(TINYTAG_ATTRIBUTES))

    def test_meta_data_output_format_tsv(self) -> None:
        output = self.run_cli('-f tsv ' + MP3_WITH_IMG)
        lines = [line for line in output.split(os.linesep) if line]
        self.assertTrue(all('\t' in line for line in lines))
        attributes = set(line.split('\t')[0] for line in lines)
        self.assertTrue(set(attributes).issubset(TINYTAG_ATTRIBUTES))

    def test_meta_data_output_format_tabularcsv(self) -> None:
        output = self.run_cli('-f tabularcsv ' + MP3_WITH_IMG)
        header, _line, _rest = output.split(os.linesep)
        self.assertTrue(set(header.split(',')).issubset(TINYTAG_ATTRIBUTES))

    def test_meta_data_output_format_invalid(self) -> None:
        output = self.run_cli('-f invalid ' + MP3_WITH_IMG)
        self.assertFalse(output)

    def test_fail_on_unsupported_file(self) -> None:
        with self.assertRaises(CalledProcessError):
            self.run_cli(BOGUS_FILE)

    def test_fail_skip_unsupported_file_long_opt(self) -> None:
        self.run_cli('--skip-unsupported ' + BOGUS_FILE)

    def test_fail_skip_unsupported_file_short_opt(self) -> None:
        self.run_cli('-s ' + BOGUS_FILE)

    def test_default_stops_at_first_error(self) -> None:
        returncode, stdout, stderr = self.run_in_process(
            [CORRUPT_OGG, VALID_MP3])
        self.assertEqual(returncode, 1)
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)
        # Processing stops at the first error, no tag output is produced.
        self.assertNotIn('"filename"', stdout)

    def test_continue_on_error_processes_remaining_files(self) -> None:
        returncode, stdout, stderr = self.run_in_process(
            ['--continue-on-error', VALID_MP3, CORRUPT_OGG, VALID_MP3])
        self.assertEqual(returncode, 1)
        # Every failure is reported on stderr.
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)
        # Successful files are still printed to stdout, in input order.
        self.assertEqual(stdout.count('{\n  "filename"'), 2)
        self.assertIn(os.path.basename(VALID_MP3), stdout)

    def test_continue_on_error_short_opt(self) -> None:
        returncode, _stdout, stderr = self.run_in_process(
            ['-c', CORRUPT_OGG])
        self.assertEqual(returncode, 1)
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)

    def test_continue_on_error_all_failures(self) -> None:
        returncode, stdout, stderr = self.run_in_process(
            ['-c', CORRUPT_OGG, BOGUS_FILE])
        self.assertEqual(returncode, 1)
        self.assertNotIn('"filename"', stdout)
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)
        self.assertIn(f'{BOGUS_FILE}: ', stderr)

    def test_continue_on_error_all_success_returns_zero(self) -> None:
        returncode, stdout, stderr = self.run_in_process(
            ['-c', VALID_MP3, MP3_WITH_IMG])
        self.assertEqual(returncode, 0)
        self.assertFalse(stderr)
        self.assertEqual(stdout.count('{\n  "filename"'), 2)

    def test_continue_on_error_subprocess_exit_code(self) -> None:
        returncode, stdout, stderr = self.run_cli_process(
            ['--continue-on-error', VALID_MP3, CORRUPT_OGG, VALID_MP3])
        self.assertEqual(returncode, 1)
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)
        self.assertEqual(stdout.count('{\n  "filename"'), 2)

    def test_skip_unsupported_with_continue_returns_zero(self) -> None:
        returncode, stdout, stderr = self.run_in_process(
            ['-c', '-s', BOGUS_FILE, VALID_MP3])
        self.assertEqual(returncode, 0)
        self.assertFalse(stderr)
        self.assertIn(os.path.basename(VALID_MP3), stdout)

    def test_skip_unsupported_continue_subprocess_exit_code(self) -> None:
        returncode, _stdout, stderr = self.run_cli_process(
            ['--continue-on-error', '--skip-unsupported', BOGUS_FILE,
             VALID_MP3])
        self.assertEqual(returncode, 0)
        self.assertFalse(stderr)

    def test_continue_on_error_save_image_bulk(self) -> None:
        with NamedTemporaryFile(suffix='.jpg') as temp_file:
            temp_name = temp_file.name
            temp_name_no_ext = temp_name[:-4]
        returncode, _stdout, stderr = self.run_in_process([
            '-c', '-i', temp_name,
            MP3_WITH_IMG, CORRUPT_OGG, MP3_WITH_IMG])
        self.assertEqual(returncode, 1)
        self.assertIn(f'{CORRUPT_OGG}: ', stderr)
        # Indexing follows the original input order: the corrupt file at
        # index 1 must not produce an image.
        self.assertGreater(
            os.path.getsize(temp_name_no_ext + '00000.jpg'), 0)
        self.assertFalse(
            os.path.isfile(temp_name_no_ext + '00001.jpg'))
        self.assertGreater(
            os.path.getsize(temp_name_no_ext + '00002.jpg'), 0)
        for index in ('00000', '00002'):
            os.remove(temp_name_no_ext + index + '.jpg')

    def test_continue_on_error_save_image_skips_unsupported(self) -> None:
        with NamedTemporaryFile(suffix='.jpg') as temp_file:
            temp_name = temp_file.name
            temp_name_no_ext = temp_name[:-4]
        returncode, _stdout, stderr = self.run_in_process([
            '-c', '-s', '-i', temp_name, BOGUS_FILE, MP3_WITH_IMG])
        self.assertEqual(returncode, 0)
        self.assertFalse(stderr)
        self.assertFalse(
            os.path.isfile(temp_name_no_ext + '00000.jpg'))
        self.assertGreater(
            os.path.getsize(temp_name_no_ext + '00001.jpg'), 0)
        os.remove(temp_name_no_ext + '00001.jpg')

    def test_version_output(self) -> None:
        returncode, stdout, _stderr = self.run_in_process(['--version'])
        self.assertEqual(returncode, 0)
        self.assertTrue(stdout.strip())

    def test_help_in_process(self) -> None:
        returncode, stdout, _stderr = self.run_in_process(['--help'])
        self.assertEqual(returncode, 0)
        self.assertIn('tinytag [options] <filename', stdout)
        self.assertIn('--continue-on-error', stdout)
        returncode, stdout, _stderr = self.run_in_process([])
        self.assertEqual(returncode, 0)
        self.assertIn('tinytag [options] <filename', stdout)

    def test_short_options_in_process(self) -> None:
        returncode, _stdout, stderr = self.run_in_process(
            ['-c', '-s', '-f', 'json', BOGUS_FILE, VALID_MP3])
        self.assertEqual(returncode, 0)
        self.assertFalse(stderr)

    def test_output_formats_in_process(self) -> None:
        for fmt in ('csv', 'tsv', 'tabularcsv'):
            with self.subTest(fmt=fmt):
                returncode, stdout, stderr = self.run_in_process(
                    ['-f', fmt, VALID_MP3])
                self.assertEqual(returncode, 0)
                self.assertFalse(stderr)
                self.assertTrue(stdout)
        returncode, stdout, _stderr = self.run_in_process(
            ['-f', 'invalid', VALID_MP3])
        self.assertEqual(returncode, 0)
        # An unknown format prints nothing (debug logs aside).
        self.assertNotIn('"filename"', stdout)

    def test_save_image_single_file_in_process(self) -> None:
        with NamedTemporaryFile(suffix='.jpg') as temp_file:
            temp_name = temp_file.name
        returncode, _stdout, _stderr = self.run_in_process(
            ['-i', temp_name, MP3_WITH_IMG])
        self.assertEqual(returncode, 0)
        self.assertGreater(os.path.getsize(temp_name), 0)
        os.remove(temp_name)

    def test_module_entry_point(self) -> None:
        completed = run(
            [executable, '-c',
             'import sys; from tinytag.__main__ import _run; '
             'sys.exit(_run(["--version"]))'],
            cwd=PROJECT_FOLDER, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0)
        self.assertTrue(completed.stdout.strip())

    def test_run_without_explicit_argv(self) -> None:
        old_argv = sys.argv
        stdout = StringIO()
        try:
            sys.argv = ['tinytag', '--version']
            with redirect_stdout(stdout):
                returncode = _run()
        finally:
            sys.argv = old_argv
        self.assertEqual(returncode, 0)
        self.assertTrue(stdout.getvalue().strip())

    def test_module_as_main(self) -> None:
        # runpy executes the module with __name__ == '__main__', covering
        # the entry-point guard without spawning a subprocess.
        import runpy  # pylint: disable=import-outside-toplevel
        old_argv = sys.argv
        stdout = StringIO()
        try:
            sys.argv = ['tinytag', '--version']
            with redirect_stdout(stdout):
                with self.assertRaises(SystemExit) as context:
                    runpy.run_module('tinytag.__main__', run_name='__main__')
        finally:
            sys.argv = old_argv
        self.assertEqual(context.exception.code, 0)
        self.assertTrue(stdout.getvalue().strip())
