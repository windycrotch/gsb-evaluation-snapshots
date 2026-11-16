"""Offline tests for renew_python_anywhere.py.

All HTTP traffic is faked with self-made HTML/JSON fixtures; no test ever
touches the real PythonAnywhere site, and no test credential is written to
the real workflow log (LOG_FILE is redirected to a temp directory).
"""

import os
import tempfile
import unittest
from unittest import mock

import renew_python_anywhere as rpa


# --------------------------------------------------------------------------
# Fake HTTP layer
# --------------------------------------------------------------------------

_NO_JSON = object()


class FakeResponse:
    def __init__(self, status_code=200, text="", url="", json_data=_NO_JSON):
        self.status_code = status_code
        self.text = text
        self.content = text.encode("utf-8")
        self.url = url
        self._json_data = json_data

    def json(self):
        if self._json_data is _NO_JSON:
            raise ValueError("response body is not valid JSON")
        return self._json_data


class FakeSession:
    """Serves queued FakeResponses keyed by (method, url)."""

    def __init__(self, routes=None, cookies=None):
        self.routes = {key: list(value) for key, value in (routes or {}).items()}
        self.cookies = cookies or {}
        self.headers = {}
        self.calls = []

    def get(self, url, **kwargs):
        return self._respond("GET", url)

    def post(self, url, **kwargs):
        return self._respond("POST", url)

    def _respond(self, method, url):
        self.calls.append((method, url))
        queue = self.routes.get((method, url))
        if not queue:
            raise AssertionError(f"Unexpected request: {method} {url}")
        return queue.pop(0)


# --------------------------------------------------------------------------
# Self-made fixtures
# --------------------------------------------------------------------------

BASE = rpa.BASE_URL
USER = "testuser"
LOGIN_URL = f"{BASE}/login/"
DASHBOARD_URL = f"{BASE}/user/{USER}/webapps/"
TASKS_API_URL = f"{BASE}/api/v0/user/{USER}/schedule/"
DOMAIN = "example.pythonanywhere.com"
EXTEND_URL = f"{BASE}/user/{USER}/webapps/{DOMAIN}/extend"

LOGIN_PAGE_OK = """
<html><body><form method="post">
  <input type="hidden" name="csrfmiddlewaretoken" value="csrf-abc">
</form></body></html>
"""

LOGIN_PAGE_NO_CSRF = """
<html><body><form method="post">
  <input type="text" name="auth-username">
</form></body></html>
"""

LOGGED_IN_HOME = "<html><body><a href='/logout/'>Log out</a></body></html>"


def dashboard_html(expiry):
    return f"""
<html><body>
  <div id="id_example_pythonanywhere_com">
    <p class="webapp_expiry">Expires: <strong>{expiry}</strong></p>
  </div>
  <form action="/user/{USER}/webapps/{DOMAIN}/extend" method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="csrf-xyz">
  </form>
</body></html>
"""


DASHBOARD_NO_EXPIRY = f"""
<html><body>
  <form action="/user/{USER}/webapps/{DOMAIN}/extend" method="post">
    <input type="hidden" name="csrfmiddlewaretoken" value="csrf-xyz">
  </form>
</body></html>
"""

NO_WEBAPPS_DASHBOARD = "<html><body><p>No web apps here.</p></body></html>"

TASK_ONE = {
    "id": 1,
    "command": "python daily_job.py",
    "expiry": "2026-12-01 00:00:00",
    "extend_url": f"/api/v0/user/{USER}/schedule/1/extend/",
}
TASK_EXTEND_URL = f"{BASE}{TASK_ONE['extend_url']}"


def logged_in_session(routes, cookies=None):
    """FakeSession pre-loaded with a successful login flow."""
    full_routes = {
        ("GET", LOGIN_URL): [FakeResponse(200, LOGIN_PAGE_OK, url=LOGIN_URL)],
        ("POST", LOGIN_URL): [
            FakeResponse(200, LOGGED_IN_HOME, url=f"{BASE}/")
        ],
    }
    for key, value in routes.items():
        full_routes.setdefault(key, []).extend(value)
    return FakeSession(full_routes, cookies=cookies or {"csrftoken": "cookie-csrf"})


def no_webapp_routes(extra_tasks_responses):
    routes = {
        ("GET", DASHBOARD_URL): [
            FakeResponse(200, NO_WEBAPPS_DASHBOARD, url=DASHBOARD_URL)
        ],
        ("GET", TASKS_API_URL): extra_tasks_responses,
    }
    return routes


class RenewTestCase(unittest.TestCase):
    def setUp(self):
        # Never sleep during tests.
        sleeper = mock.patch.object(rpa.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def run_account(self, session, label="ACCOUNT_1"):
        """Run renew_account with requests.Session replaced by the fake."""
        with mock.patch.object(rpa.requests, "Session", return_value=session):
            return rpa.renew_account(label, USER, "secret")


class LoginTests(RenewTestCase):
    def test_login_page_missing_csrf_is_login_stage_failure(self):
        session = FakeSession(
            {
                ("GET", LOGIN_URL): [
                    FakeResponse(200, LOGIN_PAGE_NO_CSRF, url=LOGIN_URL)
                ]
            }
        )
        ok, details = rpa.login(session, USER, "secret")
        self.assertFalse(ok)
        self.assertEqual(len(details), 1)
        self.assertIn("[login]", details[0])
        self.assertIn("CSRF", details[0])
        # Login POST must never be attempted without a CSRF token.
        self.assertNotIn(("POST", LOGIN_URL), session.calls)


class WebappRenewTests(RenewTestCase):
    def test_single_webapp_extend_non_200_isolated_and_tagged(self):
        routes = {
            ("GET", DASHBOARD_URL): [
                FakeResponse(200, dashboard_html("2026-12-01"), url=DASHBOARD_URL)
            ],
            ("POST", EXTEND_URL): [FakeResponse(500, "boom", url=EXTEND_URL)],
            ("GET", TASKS_API_URL): [FakeResponse(200, json_data=[])],
        }
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertFalse(ok)
        self.assertTrue(
            any("[webapp-renew]" in d and "status 500" in d for d in details),
            details,
        )

    def test_webapp_success_keeps_old_to_new_expiry(self):
        routes = {
            ("GET", DASHBOARD_URL): [
                FakeResponse(200, dashboard_html("2026-12-01"), url=DASHBOARD_URL),
                FakeResponse(200, dashboard_html("2027-02-28"), url=DASHBOARD_URL),
            ],
            ("POST", EXTEND_URL): [FakeResponse(200, "", url=DASHBOARD_URL)],
            ("GET", TASKS_API_URL): [FakeResponse(200, json_data=[])],
        }
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertTrue(ok, details)
        self.assertIn(f"Web App: {DOMAIN} (2026-12-01 → 2027-02-28)", details)

    def test_webapp_unreadable_new_expiry_is_verify_failure(self):
        routes = {
            ("GET", DASHBOARD_URL): [
                FakeResponse(200, dashboard_html("2026-12-01"), url=DASHBOARD_URL),
                FakeResponse(200, DASHBOARD_NO_EXPIRY, url=DASHBOARD_URL),
            ],
            ("POST", EXTEND_URL): [FakeResponse(200, "", url=DASHBOARD_URL)],
            ("GET", TASKS_API_URL): [FakeResponse(200, json_data=[])],
        }
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertFalse(ok)
        self.assertTrue(any("[verify]" in d for d in details), details)


class TaskRenewTests(RenewTestCase):
    def test_tasks_api_non_json_is_task_list_failure(self):
        session = logged_in_session(
            no_webapp_routes([FakeResponse(200, "<html>oops</html>")])
        )
        ok, details = self.run_account(session)
        self.assertFalse(ok)
        self.assertTrue(
            any("[task-list]" in d and "JSON" in d for d in details), details
        )

    def test_task_expiry_unchanged_means_maxed_out_not_failure(self):
        routes = no_webapp_routes(
            [
                FakeResponse(200, json_data=[TASK_ONE]),
                FakeResponse(200, json_data=[TASK_ONE]),  # refresh: same expiry
            ]
        )
        routes[("POST", TASK_EXTEND_URL)] = [
            FakeResponse(200, json_data={"ok": True})
        ]
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertTrue(ok, details)
        self.assertTrue(any("Already maxed out" in d for d in details), details)

    def test_task_missing_from_refresh_is_verify_failure(self):
        routes = no_webapp_routes(
            [
                FakeResponse(200, json_data=[TASK_ONE]),
                FakeResponse(200, json_data=[]),  # task vanished after renewal
            ]
        )
        routes[("POST", TASK_EXTEND_URL)] = [
            FakeResponse(200, json_data={"ok": True})
        ]
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertFalse(ok)
        self.assertTrue(any("[verify]" in d for d in details), details)

    def test_task_refresh_non_json_is_verify_failure(self):
        routes = no_webapp_routes(
            [
                FakeResponse(200, json_data=[TASK_ONE]),
                FakeResponse(200, "<html>not json</html>"),
            ]
        )
        routes[("POST", TASK_EXTEND_URL)] = [
            FakeResponse(200, json_data={"ok": True})
        ]
        session = logged_in_session(routes)
        ok, details = self.run_account(session)
        self.assertFalse(ok)
        self.assertTrue(
            any("[verify]" in d and "JSON" in d for d in details), details
        )


class MultiAccountTests(RenewTestCase):
    def test_failed_account_does_not_stop_next_account(self):
        # Account 1: login page has no CSRF token -> login-stage failure.
        failing_session = FakeSession(
            {
                ("GET", LOGIN_URL): [
                    FakeResponse(200, LOGIN_PAGE_NO_CSRF, url=LOGIN_URL)
                ]
            }
        )
        # Account 2: full happy path, one web app renewed, no tasks.
        working_session = logged_in_session(
            {
                ("GET", DASHBOARD_URL): [
                    FakeResponse(200, dashboard_html("2026-12-01"), url=DASHBOARD_URL),
                    FakeResponse(200, dashboard_html("2027-02-28"), url=DASHBOARD_URL),
                ],
                ("POST", EXTEND_URL): [FakeResponse(200, "", url=DASHBOARD_URL)],
                ("GET", TASKS_API_URL): [FakeResponse(200, json_data=[])],
            }
        )
        env = {
            "ACCOUNT_1_USERNAME": "broken_user",
            "ACCOUNT_1_PASSWORD": "broken_pass_123",
            "ACCOUNT_2_USERNAME": USER,
            "ACCOUNT_2_PASSWORD": "good_pass_456",
        }
        with tempfile.TemporaryDirectory() as tmp:
            log_file = os.path.join(tmp, "workflow_runs.log")
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
                rpa, "LOG_FILE", log_file
            ), mock.patch.object(
                rpa.requests, "Session", side_effect=[failing_session, working_session]
            ):
                exit_code = rpa.run()

            self.assertEqual(exit_code, 1)  # any account failed -> FAILED -> 1
            # The second account was still processed after the first failed.
            self.assertIn(("GET", DASHBOARD_URL), working_session.calls)
            self.assertIn(("POST", EXTEND_URL), working_session.calls)

            with open(log_file, encoding="utf-8") as handle:
                log_text = handle.read()

        self.assertIn("Status: FAILED", log_text)
        self.assertIn("- ACCOUNT_1: FAILED", log_text)
        self.assertIn("- ACCOUNT_2: SUCCESS", log_text)
        self.assertIn("[login]", log_text)
        self.assertIn(f"Web App: {DOMAIN} (2026-12-01 → 2027-02-28)", log_text)
        # Test credentials must never end up in the log.
        self.assertNotIn("broken_pass_123", log_text)
        self.assertNotIn("good_pass_456", log_text)


if __name__ == "__main__":
    unittest.main()
