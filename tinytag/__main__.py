# SPDX-FileCopyrightText: 2015-2024 tinytag Contributors
# SPDX-License-Identifier: MIT

# pylint: disable=missing-module-docstring,protected-access

from __future__ import annotations

import sys

from io import StringIO
from os.path import isfile, splitext

from tinytag import TinyTag, TinyTagException, __version__


def _usage() -> None:
    print('''tinytag [options] <filename...>

    -h, --help
        Display help

    -i, --save-image <image-path>
        Save the cover art to a file

    -f, --format json|csv|tsv|tabularcsv
        Specify how the output should be formatted

    -s, --skip-unsupported
        Skip files that do not have a file extension supported by tinytag

    -c, --continue-on-error
        Do not stop at the first bad file: report every failure to stderr
        and keep processing the remaining files

    -v, --version
        Display version

''')


def _pop_param(name: str, argv: list[str], _default: str | None) -> str | None:
    if name in argv:
        idx = argv.index(name)
        argv.pop(idx)
        return argv.pop(idx)
    return _default


def _pop_switch(name: str, argv: list[str]) -> bool:
    if name in argv:
        idx = argv.index(name)
        argv.pop(idx)
        return True
    return False


def _print_tag(tag: TinyTag, fmt: str, header_printed: bool = False) -> bool:
    data = tag.as_dict()
    if fmt == 'json':
        import json  # pylint: disable=import-outside-toplevel
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return header_printed
    if fmt not in {'csv', 'tsv', 'tabularcsv'}:
        return header_printed
    import csv  # pylint: disable=import-outside-toplevel
    for field, value in data.items():
        if isinstance(value, str):
            # use a more friendly separator for output
            data[field] = value.replace('\x00', ';')
    csv_file = StringIO()
    delimiter = '\t' if fmt == 'tsv' else ','
    writer = csv.writer(csv_file, delimiter=delimiter, lineterminator='\n')
    if fmt == 'tabularcsv':
        if not header_printed:
            writer.writerow(data.keys())
            header_printed = True
        writer.writerow(data.values())
        value = csv_file.getvalue().strip()
    else:
        writer.writerows(data.items())
        value = csv_file.getvalue()
    print(value)
    return header_printed


def _run(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    argv = list(argv)
    header_printed = False
    image_path = _pop_param('--save-image', argv, None) \
        or _pop_param('-i', argv, None)
    fmt = (_pop_param('--format', argv, None)
           or _pop_param('-f', argv, None)) or 'json'
    skip_unsupported = (_pop_switch('--skip-unsupported', argv)
                        or _pop_switch('-s', argv))
    continue_on_error = (_pop_switch('--continue-on-error', argv)
                         or _pop_switch('-c', argv))
    filenames = argv
    display_help = not filenames or _pop_switch('--help', argv) \
        or _pop_switch('-h', argv)
    if display_help:
        _usage()
        return 0
    display_version = (_pop_switch('--version', argv)
                       or _pop_switch('-v', argv))
    if display_version:
        print(__version__)
        return 0

    error_count = 0
    for i, filename in enumerate(filenames):
        if (skip_unsupported
                and not (TinyTag.is_supported(filename) and isfile(filename))):
            continue
        try:
            tag = TinyTag.get(filename, image=image_path is not None)
            if image_path:
                # allow for saving the image of multiple files
                actual_image_path = image_path
                if len(filenames) > 1:
                    actual_image_path, ext = splitext(actual_image_path)
                    actual_image_path += f'{i:05d}{ext}'
                image = tag.images.any
                if image is not None:
                    with open(actual_image_path, 'wb') as file_handle:
                        file_handle.write(image.data)
            header_printed = _print_tag(tag, fmt, header_printed)
        except (OSError, TinyTagException) as exc:
            sys.stderr.write(f'{filename}: {exc}\n')
            if not continue_on_error:
                return 1
            error_count += 1
    return 1 if error_count else 0


if __name__ == '__main__':
    sys.exit(_run())
