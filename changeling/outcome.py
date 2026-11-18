"""outcome.py - how a headless run (-s -t -o) ends, made script-readable.

A windowed run reports through the status bar and the completion bar, as always. A headless
run instead ends with exactly one result line on stdout and a matching process exit code:

    CHANGELING_RESULT {"status": "success", "reason": "...", "output": "..."}

    status         exit code
    success        0   the job finished and this run produced the output file
    failed         1   processing failed (no frames extracted, no output written, ...)
    invalid-input  2   the source or target can never be processed (not an image,
                       no face in the source, target neither image nor video)
    refused        3   the NSFW check refused the target

The exit code and the result line always agree: 0 is only ever sent with "success".
Only standard library here, so the ending can be reported no matter what failed to load.
"""
import json
import sys
from typing import NoReturn, Optional

SUCCESS = 'success'
FAILED = 'failed'
INVALID_INPUT = 'invalid-input'
REFUSED = 'refused'

EXIT_CODES = {
    SUCCESS: 0,
    FAILED: 1,
    INVALID_INPUT: 2,
    REFUSED: 3,
}

PREFIX = 'CHANGELING_RESULT'


def result_line(status: str, reason: str, output: Optional[str] = None) -> str:
    """The one structured line a headless run prints at its end."""
    payload = {'status': status, 'reason': reason, 'output': output}
    return f'{PREFIX} {json.dumps(payload)}'


def report(status: str, reason: str, output: Optional[str] = None) -> str:
    """Print the result line; return it (tests and callers can check what was said)."""
    line = result_line(status, reason, output)
    print(line, flush=True)
    return line


def conclude(status: str, reason: str, output: Optional[str] = None) -> NoReturn:
    """Print the result line and leave the process with the matching exit code."""
    report(status, reason, output)
    sys.exit(EXIT_CODES[status])
