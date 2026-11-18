# SPDX-FileCopyrightText: 2026 tinytag Contributors
# SPDX-License-Identifier: MIT

# pylint: disable=missing-class-docstring,missing-function-docstring
# pylint: disable=missing-module-docstring

import os.path

from io import BytesIO
from unittest import TestCase

from tinytag import (
    ParseError, TagReadResult, TinyTag, TinyTagException,
    UnsupportedFormatError,
)

SAMPLE_FOLDER = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'samples')
SAMPLE_MP3 = os.path.join(SAMPLE_FOLDER, 'cbr.mp3')
SAMPLE_FLAC = os.path.join(SAMPLE_FOLDER, 'flac1sMono.flac')
SAMPLE_OPUS = os.path.join(SAMPLE_FOLDER, '8khz_5s.opus')
CORRUPT_OGG = os.path.join(SAMPLE_FOLDER, 'invalid_file.ogg')
CORRUPT_FLAC = os.path.join(SAMPLE_FOLDER, 'invalid_file.flac')
CORRUPT_M4A = os.path.join(SAMPLE_FOLDER, 'invalid_file.m4a')
UNSUPPORTED_FILE = os.path.join(
    SAMPLE_FOLDER, 'there_is_no_such_ext.bogus')


class TestGetMany(TestCase):

    def assert_successful(self, result: TagReadResult,
                          source: object) -> TinyTag:
        self.assertIs(result.source, source)
        self.assertTrue(result.success)
        self.assertIsNone(result.error)
        self.assertIsInstance(result.tag, TinyTag)
        assert result.tag is not None
        return result.tag

    def assert_failed(self, result: TagReadResult, source: object,
                      exception_type: type) -> Exception:
        self.assertIs(result.source, source)
        self.assertFalse(result.success)
        self.assertIsNone(result.tag)
        self.assertIsInstance(result.error, exception_type)
        assert result.error is not None
        return result.error

    def test_all_files_succeed(self) -> None:
        paths = [SAMPLE_MP3, SAMPLE_FLAC, SAMPLE_OPUS]
        results = TinyTag.get_many(paths)
        self.assertEqual(len(results), len(paths))
        self.assertTrue(all(result.success for result in results))
        for result, path in zip(results, paths):
            tag = self.assert_successful(result, path)
            self.assertEqual(tag.filename, path)
            self.assertIsNotNone(tag.duration)

    def test_corrupt_file_does_not_stop_remaining_files(self) -> None:
        paths = [SAMPLE_MP3, CORRUPT_OGG, SAMPLE_FLAC]
        results = TinyTag.get_many(paths)
        self.assertEqual(len(results), 3)
        self.assert_successful(results[0], paths[0])
        error = self.assert_failed(results[1], paths[1], ParseError)
        self.assertIsInstance(error, TinyTagException)
        self.assertTrue(str(error))
        # The file after the corrupt one must still have been processed.
        self.assert_successful(results[2], paths[2])

    def test_all_files_fail(self) -> None:
        paths = [CORRUPT_OGG, CORRUPT_FLAC, CORRUPT_M4A]
        results = TinyTag.get_many(paths)
        self.assertEqual(len(results), 3)
        for result, path in zip(results, paths):
            self.assert_failed(result, path, ParseError)
        # Failures must not be swallowed into empty tag results.
        self.assertTrue(all(result.tag is None for result in results))

    def test_unsupported_format_error_is_preserved(self) -> None:
        results = TinyTag.get_many([UNSUPPORTED_FILE])
        self.assertEqual(len(results), 1)
        self.assert_failed(results[0], UNSUPPORTED_FILE,
                           UnsupportedFormatError)

    def test_repeated_calls_give_consistent_results(self) -> None:
        paths = [SAMPLE_MP3, CORRUPT_OGG, SAMPLE_FLAC]
        first = TinyTag.get_many(paths)
        second = TinyTag.get_many(paths)
        self.assertEqual(len(first), len(second))
        for first_result, second_result in zip(first, second):
            self.assertEqual(first_result.success, second_result.success)
            self.assertEqual(type(first_result.error),
                             type(second_result.error))
            self.assertEqual(str(first_result.error),
                             str(second_result.error))
            if first_result.tag is not None:
                second_tag = second_result.tag
                assert second_tag is not None
                self.assertEqual(first_result.tag.as_dict(),
                                 second_tag.as_dict())

    def test_file_objects_are_supported(self) -> None:
        with open(SAMPLE_MP3, 'rb') as file_handle:
            results = TinyTag.get_many([file_handle])
        self.assertEqual(len(results), 1)
        self.assert_successful(results[0], file_handle)

    def test_corrupt_file_object_does_not_stop_remaining_inputs(self) -> None:
        with open(SAMPLE_MP3, 'rb') as good_file, \
                open(CORRUPT_OGG, 'rb') as bad_file:
            good_data = good_file.read()
            bad_data = bad_file.read()
        bad_input = BytesIO(bad_data)
        results = TinyTag.get_many([
            BytesIO(good_data), bad_input, BytesIO(good_data)])
        self.assertEqual(len(results), 3)
        self.assertTrue(results[0].success)
        # Without a filename, the type is determined by magic bytes, so
        # the corrupt stream is reported as unsupported rather than a
        # parse error. Either way the original exception is preserved.
        self.assert_failed(
            results[1], bad_input, TinyTagException)
        self.assertIsInstance(results[1].error, UnsupportedFormatError)
        self.assertTrue(results[2].success)

    def test_empty_input(self) -> None:
        self.assertEqual(TinyTag.get_many([]), [])

    def test_keyword_arguments_are_forwarded(self) -> None:
        results = TinyTag.get_many([SAMPLE_MP3], tags=False)
        tag = self.assert_successful(results[0], SAMPLE_MP3)
        self.assertIsNone(tag.artist)
        self.assertIsNotNone(tag.duration)

    def test_result_representation(self) -> None:
        success_result = TinyTag.get_many([SAMPLE_MP3])[0]
        self.assertIn('TagReadResult', repr(success_result))
        self.assertIn('tag=', repr(success_result))
        failure_result = TinyTag.get_many([CORRUPT_OGG])[0]
        failure_repr = repr(failure_result)
        self.assertIn('TagReadResult', failure_repr)
        self.assertIn('error=', failure_repr)
        self.assertIn('ParseError', failure_repr)
