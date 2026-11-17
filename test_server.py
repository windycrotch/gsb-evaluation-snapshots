#!/usr/bin/env python3
"""
Automated tests for server.py (stdlib only).

Run from the repository root, either as:
    python -m unittest -v test_server
or directly:
    python test_server.py

The tests start the real ThreadingHTTPServer from server.py on an ephemeral
127.0.0.1 port, but redirect SAVE_FILE into a private temp directory so the
real save.txt in the game folder is never touched.
"""
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import server as srv  # noqa: E402


class ServerTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix='skybreak-test-')
        self.save_path = os.path.join(self.tmpdir, 'save.txt')
        self._orig_save_file = srv.SAVE_FILE
        srv.SAVE_FILE = self.save_path

        self.httpd = srv.http.server.ThreadingHTTPServer(
            ('127.0.0.1', 0), srv.Handler)
        self.port = self.httpd.server_address[1]
        self.server_thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.server_thread.join(timeout=5)
        srv.SAVE_FILE = self._orig_save_file
        for name in os.listdir(self.tmpdir):
            os.remove(os.path.join(self.tmpdir, name))
        os.rmdir(self.tmpdir)

    # -- helpers ---------------------------------------------------------

    def post(self, body, extra_headers=None, path='/save', skybreak=True):
        """POST through a real HTTP client; Content-Length is set automatically."""
        if isinstance(body, str):
            body = body.encode('utf-8')
        headers = {}
        if skybreak:
            headers['X-Skybreak'] = '1'
        if extra_headers:
            headers.update(extra_headers)
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        try:
            conn.request('POST', path, body=body, headers=headers)
            resp = conn.getresponse()
            resp.read()
            return resp.status
        finally:
            conn.close()

    def raw_post(self, request_bytes, shutdown_write=False):
        """Send a hand-built raw request and return the raw response bytes.

        shutdown_write half-closes the sending side: useful for truncated-body
        tests where Content-Length promises more bytes than were sent, while
        keeping the receive side open so the server's error response can arrive.
        """
        with socket.create_connection(('127.0.0.1', self.port), timeout=10) as sock:
            sock.sendall(request_bytes)
            if shutdown_write:
                sock.shutdown(socket.SHUT_WR)
            sock.settimeout(5)
            chunks = []
            while True:
                try:
                    chunk = sock.recv(4096)
                except socket.timeout:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
        return b''.join(chunks)

    def raw_status(self, request_bytes, shutdown_write=False):
        response = self.raw_post(request_bytes, shutdown_write=shutdown_write)
        self.assertTrue(response, 'server sent no response')
        return int(response.split(b'\r\n', 1)[0].split()[1])

    def write_existing_save(self, text='{"existing": true}'):
        with open(self.save_path, 'w', encoding='utf-8') as f:
            f.write(text)

    def assert_save_unchanged(self, expected='{"existing": true}'):
        with open(self.save_path, encoding='utf-8') as f:
            self.assertEqual(f.read(), expected)

    def assert_no_temp_files(self):
        leftovers = [n for n in os.listdir(self.tmpdir) if '.tmp' in n]
        self.assertEqual(leftovers, [])


class TestNormalWrites(ServerTestBase):
    def test_valid_write_returns_204_and_persists_object(self):
        payload = {
            'best': 42,
            'callsign': 'tëst✈',
            'hangar': [{'parts': [1, 2, 3]}],
        }
        status = self.post(json.dumps(payload))
        self.assertEqual(status, 204)

        with open(self.save_path, encoding='utf-8') as f:
            on_disk = json.load(f)
        self.assertEqual(on_disk, payload)
        self.assert_no_temp_files()

    def test_max_size_object_accepted(self):
        # Exactly the limit is still legal; only strictly larger is rejected.
        body = json.dumps({'pad': 'a' * (srv.MAX_BYTES - 16)}).encode('utf-8')
        self.assertLessEqual(len(body), srv.MAX_BYTES)
        status = self.post(body)
        self.assertEqual(status, 204)
        self.assertTrue(os.path.exists(self.save_path))

    def test_get_still_serves_game_files(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('GET', '/index.html')
            resp = conn.getresponse()
            body = resp.read()
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.getheader('X-Skybreak-Server'), '1')
            self.assertIn(b'no-store', resp.getheader('Cache-Control').encode())
            self.assertIn(b'<html', body[:200].lower())
        finally:
            conn.close()


class TestConcurrentWrites(ServerTestBase):
    def test_concurrent_posts_leave_one_complete_save(self):
        n_threads = 12
        rounds = 3
        for rnd in range(rounds):
            barrier = threading.Barrier(n_threads)
            statuses = {}
            payloads = {}

            def worker(i):
                payload = {
                    'id': i,
                    'round': rnd,
                    'marker': 'x' * 64,
                    'numbers': list(range(20)),
                }
                payloads[i] = payload
                barrier.wait()  # maximize simultaneity
                conn = http.client.HTTPConnection(
                    '127.0.0.1', self.port, timeout=20)
                try:
                    conn.request(
                        'POST', '/save',
                        body=json.dumps(payload).encode('utf-8'),
                        headers={'X-Skybreak': '1'})
                    resp = conn.getresponse()
                    statuses[i] = resp.status
                    resp.read()
                finally:
                    conn.close()

            threads = [
                threading.Thread(target=worker, args=(i,))
                for i in range(n_threads)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(set(statuses.values()), {204})

            # The file must parse as JSON and be exactly one request's full
            # payload -- never an interleaving of two requests.
            with open(self.save_path, encoding='utf-8') as f:
                final = json.load(f)
            self.assertIn(final['id'], payloads)
            self.assertEqual(final, payloads[final['id']])
            self.assertEqual(final['round'], rnd)
            self.assert_no_temp_files()

    def test_concurrent_valid_and_invalid_requests(self):
        # Invalid requests must not disturb a valid save landing concurrently.
        self.write_existing_save()
        barrier = threading.Barrier(4)
        outcomes = []

        def good():
            barrier.wait()
            outcomes.append(('good', self.post(json.dumps({'ok': 1}))))

        def bad_utf8():
            barrier.wait()
            outcomes.append(('utf8', self.post(b'\xff\xfe{invalid')))

        def bad_json():
            barrier.wait()
            outcomes.append(('json', self.post('not json at all')))

        def bad_type():
            barrier.wait()
            outcomes.append(('array', self.post('[1, 2, 3]')))

        threads = [threading.Thread(target=f) for f in
                   (good, bad_utf8, bad_json, bad_type)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        result = dict(outcomes)
        self.assertEqual(result['good'], 204)
        self.assertEqual(result['utf8'], 400)
        self.assertEqual(result['json'], 400)
        self.assertEqual(result['array'], 400)
        with open(self.save_path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'ok': 1})
        self.assert_no_temp_files()


class TestInvalidBodies(ServerTestBase):
    def test_invalid_utf8_returns_400_and_keeps_old_save(self):
        self.write_existing_save()
        status = self.post(b'\xff\xfe\x00{"a":1}')
        self.assertEqual(status, 400)
        self.assert_save_unchanged()
        self.assert_no_temp_files()

    def test_non_json_returns_400_and_keeps_old_save(self):
        self.write_existing_save()
        status = self.post('plain text, definitely not JSON')
        self.assertEqual(status, 400)
        self.assert_save_unchanged()

    def test_malformed_json_returns_400(self):
        self.write_existing_save()
        status = self.post('{"unterminated": ')
        self.assertEqual(status, 400)
        self.assert_save_unchanged()

    def test_json_array_returns_400(self):
        self.write_existing_save()
        status = self.post('[1, 2, 3]')
        self.assertEqual(status, 400)
        self.assert_save_unchanged()

    def test_json_scalars_return_400(self):
        self.write_existing_save()
        for body in ('42', '3.14', '"a string"', 'true', 'false', 'null'):
            self.assertEqual(self.post(body), 400, body)
        self.assert_save_unchanged()

    def test_truncated_body_returns_400(self):
        # Declares 100 bytes but only sends 10 then hangs up.
        self.write_existing_save()
        request = (
            b'POST /save HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'X-Skybreak: 1\r\n'
            b'Connection: close\r\n'
            b'Content-Length: 100\r\n\r\n'
            b'{"short":'
        )
        status = self.raw_status(request, shutdown_write=True)
        self.assertEqual(status, 400)
        self.assert_save_unchanged()
        self.assert_no_temp_files()


class TestContentLength(ServerTestBase):
    def _raw(self, length_header, send_body=True):
        body = b'{"x":1}'
        request = (
            b'POST /save HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'X-Skybreak: 1\r\n'
            b'Connection: close\r\n'
            + (b'Content-Length: ' + length_header + b'\r\n'
               if length_header is not None else b'')
            + b'\r\n'
        )
        if send_body:
            request += body
        return request

    def test_missing_content_length_returns_413_without_reading_body(self):
        self.write_existing_save()
        # Headers declare an oversized body that we never actually send; the
        # server must answer before waiting for any body bytes.
        request = (
            b'POST /save HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'X-Skybreak: 1\r\n'
            b'Connection: close\r\n\r\n'
        )
        status = self.raw_status(request)
        self.assertEqual(status, 413)
        self.assert_save_unchanged()

    def test_negative_content_length_returns_413_without_reading_body(self):
        self.write_existing_save()
        request = (
            b'POST /save HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'X-Skybreak: 1\r\n'
            b'Connection: close\r\n'
            b'Content-Length: -5\r\n\r\n'
        )
        # Body deliberately never sent: proves the server does not read it.
        status = self.raw_status(request)
        self.assertEqual(status, 413)
        self.assert_save_unchanged()

    def test_garbage_content_length_returns_413(self):
        self.write_existing_save()
        status = self.raw_status(self._raw(b'not-a-number'))
        self.assertEqual(status, 413)
        self.assert_save_unchanged()

    def test_zero_content_length_returns_413(self):
        self.write_existing_save()
        status = self.raw_status(self._raw(b'0'))
        self.assertEqual(status, 413)
        self.assert_save_unchanged()

    def test_oversize_returns_413_without_reading_body(self):
        self.write_existing_save()
        # Declare MAX_BYTES+1 but send nothing. A server that tried to read the
        # body first would hang here instead of replying.
        request = (
            b'POST /save HTTP/1.1\r\n'
            b'Host: 127.0.0.1\r\n'
            b'X-Skybreak: 1\r\n'
            b'Connection: close\r\n'
            b'Content-Length: %d\r\n\r\n' % (srv.MAX_BYTES + 1)
        )
        status = self.raw_status(request)
        self.assertEqual(status, 413)
        self.assert_save_unchanged()
        self.assert_no_temp_files()

    def test_oversize_via_http_client_returns_413(self):
        self.write_existing_save()
        body = b'{"pad":"' + b'a' * (srv.MAX_BYTES + 1) + b'"}'
        self.assertGreater(len(body), srv.MAX_BYTES)
        status = self.post(body)
        self.assertEqual(status, 413)
        self.assert_save_unchanged()


class TestHeaderAndPathRules(ServerTestBase):
    def test_missing_x_skybreak_header_returns_403(self):
        self.write_existing_save()
        status = self.post('{"a":1}', skybreak=False)
        self.assertEqual(status, 403)
        self.assert_save_unchanged()

    def test_wrong_x_skybreak_header_value_returns_403(self):
        self.write_existing_save()
        status = self.post('{"a":1}', extra_headers={'X-Skybreak': '2'})
        self.assertEqual(status, 403)
        self.assert_save_unchanged()

    def test_post_to_other_path_returns_404(self):
        for path in ('/other', '/save/', '/save/x', '/'):
            status = self.post('{"a":1}', path=path)
            self.assertEqual(status, 404, path)

    def test_404_takes_precedence_over_missing_header(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request('POST', '/nope', body=b'{}', headers={})
            resp = conn.getresponse()
            resp.read()
            self.assertEqual(resp.status, 404)
        finally:
            conn.close()


class TestWriteFailures(ServerTestBase):
    def test_temp_file_write_failure_keeps_old_save_and_returns_500(self):
        self.write_existing_save()
        real_open = open

        def failing_open(path, *args, **kwargs):
            mode = args[0] if args else kwargs.get('mode', 'r')
            if 'w' in mode or 'a' in mode:
                raise OSError('simulated disk full')
            return real_open(path, *args, **kwargs)

        # Only patch the open the server module resolves; the HTTP machinery's
        # own socket file objects and the test's reads keep using the real one.
        with mock.patch.object(srv, 'open', side_effect=failing_open, create=True):
            status = self.post('{"new": "data"}')
        self.assertEqual(status, 500)
        self.assert_save_unchanged()
        self.assert_no_temp_files()

    def test_replace_failure_keeps_old_save_cleans_temp_returns_500(self):
        self.write_existing_save()
        with mock.patch.object(
                srv.os, 'replace', side_effect=OSError('simulated denial')):
            status = self.post('{"new": "data"}')
        self.assertEqual(status, 500)
        self.assert_save_unchanged()
        self.assert_no_temp_files()

    def test_server_keeps_serving_after_a_failed_write(self):
        # A failed request must not crash the process or poison later requests.
        with mock.patch.object(
                srv.os, 'replace', side_effect=OSError('boom')):
            self.assertEqual(self.post('{"a":1}'), 500)
        self.assertEqual(self.post('{"a":2}'), 204)
        with open(self.save_path, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'a': 2})
        self.assert_no_temp_files()


if __name__ == '__main__':
    unittest.main(verbosity=2)
