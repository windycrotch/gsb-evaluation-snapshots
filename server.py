#!/usr/bin/env python3
"""
Skybreak Protocol local server, launched by start.command.

It does two things:
1. Serves the game files, sending Cache-Control: no-store on every file.
   (Python's built-in http.server sends no cache headers, so Chrome can keep using stale
   JS modules from its cache after a refresh. That caused the old "no hangar on start" bug.)
2. Receives saves: POST /save writes save.txt in this folder.
   A web page has no permission to write to disk, so this local server writes it instead.

Security:
- Listens on 127.0.0.1 only; other devices on the network can't reach it.
- POST requires the custom header X-Skybreak: 1. Browsers send an OPTIONS preflight before
  any cross-site request with a custom header, and this server never answers the preflight,
  so other websites open on your computer can't overwrite your save.
- Only ever writes the fixed file name save.txt; the path never comes from the request (no path traversal).
- 512KB limit, must be a JSON object, written to a temp file then atomically replaced
  (a power cut mid-write can't corrupt the save).

Concurrency / failure hardening:
- Saves are serialized with a process-wide lock, and every request gets its own uniquely
  named temp file. When several POST /save requests arrive together, each one is written
  out in full and os.replace() puts exactly one complete file in place of save.txt;
  contents can never interleave and a half-written file can never appear at save.txt.
- Any error while writing the temp file or replacing save.txt is caught: the temp file is
  removed, the existing save.txt is left byte-for-byte untouched, and the client gets a
  500 response instead of crashing the server process.
"""
import http.server
import itertools
import json
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SAVE_FILE = os.path.join(HERE, 'save.txt')
MAX_BYTES = 512 * 1024

# Serializes the whole write-temp-then-replace sequence so concurrent POST /save
# requests can never interleave their file operations.
_save_lock = threading.Lock()
# Combined with the thread id, gives every request its own temp file name, so a
# failed request's leftovers can never collide with another request's temp file.
_tmp_counter = itertools.count()
_tmp_name_lock = threading.Lock()


def _next_tmp_path():
    with _tmp_name_lock:
        seq = next(_tmp_counter)
    return '%s.tmp.%d.%d' % (SAVE_FILE, threading.get_ident(), seq)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=HERE, **kwargs)

    def end_headers(self):
        # Tells the game it is talking to this server. A static host (GitHub Pages, itch.io) may also serve a
        # save.txt if one was uploaded by mistake; without this header the game ignores it, so one person's
        # save can never overwrite every visitor's progress.
        self.send_header('X-Skybreak-Server', '1')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def _safe_error(self, code, message=None):
        """send_error that never propagates a broken-pipe error into the server thread."""
        try:
            self.send_error(code, message)
        except (BrokenPipeError, ConnectionResetError, OSError):
            # The client went away before it could read the response. Nothing else to do.
            self.close_connection = True

    def do_POST(self):
        try:
            self._handle_save_post()
        except (BrokenPipeError, ConnectionResetError):
            # Client disconnected mid-request. The existing save.txt is untouched; just
            # close this connection and keep serving everyone else.
            self.close_connection = True
        except Exception:
            # Last-resort guard: a surprise error in one request must never take the
            # server process down. No file operation reaches here without its own cleanup.
            self.log_error('unhandled error in POST %s', self.path)
            self._safe_error(500, 'internal server error')

    def _handle_save_post(self):
        if self.path != '/save':
            self._safe_error(404)
            return
        if self.headers.get('X-Skybreak') != '1':
            self._safe_error(403, 'missing X-Skybreak header')
            return

        # Validate Content-Length before touching the request body or the disk.
        # Missing, unparsable, zero/negative and oversized values are all rejected here,
        # without reading a single byte of the body.
        raw_length = self.headers.get('Content-Length')
        if raw_length is None:
            # The declared length is missing, so the body length is unknown; the 512KB
            # limit cannot be enforced. Refuse rather than read an unbounded stream.
            self.close_connection = True
            self._safe_error(413, 'Content-Length required')
            return
        try:
            n = int(raw_length)
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BYTES:
            # Do not read the body: on a keep-alive connection the unread bytes would
            # corrupt the next request, so force this connection to close.
            self.close_connection = True
            self._safe_error(413, 'bad size')
            return

        raw = self.rfile.read(n)
        if len(raw) < n:
            # Client sent fewer bytes than it declared (truncated/aborted request).
            # Never write a partial save; drop the rest of this connection.
            self.close_connection = True
            self._safe_error(400, 'truncated request body')
            return

        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            self._safe_error(400, 'body is not valid UTF-8')
            return
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            self._safe_error(400, 'body is not valid JSON')
            return
        if not isinstance(data, dict):
            self._safe_error(400, 'expected a JSON object')
            return

        self._atomic_write_save(data)

    def _atomic_write_save(self, data):
        tmp = _next_tmp_path()
        try:
            with _save_lock:
                try:
                    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, SAVE_FILE)      # atomic on Windows and POSIX
                except BaseException:
                    # Whether the failure was an I/O error or anything else (e.g. the
                    # process being interrupted), never leave a temp file behind and
                    # never touch the existing save.txt. os.replace either ran (the new
                    # save is fully in place) or did not run (the old one is intact).
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                    raise
        except (OSError, ValueError):
            # Disk full, folder read-only, replacement failed, ... the previous save.txt
            # is byte-for-byte unchanged because the replacement never happened.
            self._safe_error(500, 'could not write save')
            return

        try:
            self.send_response(204)
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main()
