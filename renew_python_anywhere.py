import os
import json
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()

# Emoji status lines must not crash on consoles with legacy encodings
# (e.g. GBK on Windows); fall back to replacement characters there.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

BASE_URL = "https://www.pythonanywhere.com"
LOG_FILE = ".github/logs/workflow_runs.log"
ACCOUNT_PATTERN = re.compile(r"^ACCOUNT_(\d+)_(USERNAME|PASSWORD)$")

# Stage names used to tag every failure detail so the log shows exactly
# which step of the renewal flow broke.
STAGE_LOGIN = "login"
STAGE_WEBAPP_LIST = "webapp-list"
STAGE_WEBAPP_RENEW = "webapp-renew"
STAGE_TASK_LIST = "task-list"
STAGE_TASK_RENEW = "task-renew"
STAGE_VERIFY = "verify"
STAGE_UNKNOWN = "unknown"


def failure(stage, message):
    """Format a failure detail entry with its stage name."""
    return f"[{stage}] {message}"


def get_accounts_from_env():
    """Return configured accounts, incomplete pairs, and duplicate warnings."""
    accounts = []
    incomplete = []
    warnings = []
    seen_credentials = set()
    numbered = {}

    credentials_json = os.environ.get("ACCOUNT_CREDENTIALS_JSON", "").strip()
    if credentials_json:
        try:
            configured = json.loads(credentials_json)
        except json.JSONDecodeError:
            incomplete.append("ACCOUNT_CREDENTIALS_JSON (invalid JSON)")
            configured = []
        if isinstance(configured, dict):
            configured = [
                {"username": username, "password": password}
                for username, password in configured.items()
            ]
        if not isinstance(configured, list):
            incomplete.append("ACCOUNT_CREDENTIALS_JSON (expected a list or object)")
            configured = []
        for index, account in enumerate(configured, 1):
            if not isinstance(account, dict):
                incomplete.append(f"ACCOUNT_CREDENTIALS_JSON item {index}")
                continue
            username = account.get("username", "")
            password = account.get("password", "")
            username = username.strip() if isinstance(username, str) else ""
            password = password.strip() if isinstance(password, str) else ""
            label = f"ACCOUNT_CREDENTIALS_JSON item {index}"
            if not username or not password:
                incomplete.append(label)
                continue
            if (username, password) in seen_credentials:
                warnings.append(f"{label} (duplicate credentials, skipped)")
                continue
            seen_credentials.add((username, password))
            accounts.append((label, username, password))

    legacy_username = os.environ.get("PA_USERNAME", "").strip()
    legacy_password = os.environ.get("PA_PASSWORD", "").strip()
    if legacy_username or legacy_password:
        if legacy_username and legacy_password:
            if (legacy_username, legacy_password) in seen_credentials:
                warnings.append("PA_USERNAME/PA_PASSWORD (duplicate credentials, skipped)")
            else:
                seen_credentials.add((legacy_username, legacy_password))
                accounts.append(("PA", legacy_username, legacy_password))
        else:
            incomplete.append("PA_USERNAME/PA_PASSWORD")

    for name, value in os.environ.items():
        match = ACCOUNT_PATTERN.match(name)
        if match:
            index, field = match.groups()
            numbered.setdefault(index, {})[field] = value.strip()

    for index in sorted(numbered, key=int):
        username = numbered[index].get("USERNAME", "")
        password = numbered[index].get("PASSWORD", "")
        if not username and not password:
            continue
        label = f"ACCOUNT_{index}_USERNAME/ACCOUNT_{index}_PASSWORD"
        if not username or not password:
            incomplete.append(label)
            continue
        if (username, password) in seen_credentials:
            warnings.append(f"{label} (duplicate credentials, skipped)")
            continue
        seen_credentials.add((username, password))
        accounts.append((f"ACCOUNT_{index}", username, password))

    return accounts, incomplete, warnings


def login(session, username, password):
    """Log in and return (ok, failure_details). Failures are tagged [login]."""
    login_url = f"{BASE_URL}/login/"
    print(f"🔐 Logging in as {username}...")
    try:
        login_page = session.get(login_url, timeout=10)
    except requests.RequestException as error:
        detail = failure(STAGE_LOGIN, f"login page request failed: {error}")
        print(f"❌ {detail}")
        return False, [detail]
    if login_page.status_code != 200:
        detail = failure(
            STAGE_LOGIN, f"login page returned status {login_page.status_code}"
        )
        print(f"❌ {detail}")
        return False, [detail]

    soup = BeautifulSoup(login_page.content, "html.parser")
    csrf_token = soup.find("input", {"name": "csrfmiddlewaretoken"})
    if not csrf_token:
        detail = failure(STAGE_LOGIN, "missing CSRF token on login page")
        print(f"❌ {detail}")
        return False, [detail]

    try:
        response = session.post(
            login_url,
            data={
                "csrfmiddlewaretoken": csrf_token["value"],
                "auth-username": username,
                "auth-password": password,
                "login_view-current_step": "auth",
            },
            headers={"Referer": login_url},
            timeout=10,
            allow_redirects=True,
        )
    except requests.RequestException as error:
        detail = failure(STAGE_LOGIN, f"login submit failed: {error}")
        print(f"❌ {detail}")
        return False, [detail]
    if response.status_code != 200:
        detail = failure(
            STAGE_LOGIN, f"login submit returned status {response.status_code}"
        )
        print(f"❌ {detail}")
        return False, [detail]
    if "log out" not in response.text.lower() or "login" in response.url.lower():
        detail = failure(STAGE_LOGIN, "credentials rejected (still on login page)")
        print(f"❌ {detail}")
        return False, [detail]

    print("✅ Login successful")
    return True, []


def get_webapp_expiry(soup, domain):
    pane = soup.find(id=f"id_{domain.replace('.', '_')}")
    if pane:
        expiry = pane.find("p", class_="webapp_expiry")
        if expiry and expiry.find("strong"):
            return expiry.find("strong").text.strip()
    return "Unknown Date"


def renew_webapps(session, username):
    """Renew every web app; each app's failure is isolated and stage-tagged."""
    dashboard_url = f"{BASE_URL}/user/{username}/webapps/"
    print("📊 Checking web apps...")
    time.sleep(1)
    try:
        dashboard = session.get(dashboard_url, timeout=10)
    except requests.RequestException as error:
        return False, [failure(STAGE_WEBAPP_LIST, f"dashboard request failed: {error}")]
    if dashboard.status_code != 200:
        return False, [
            failure(
                STAGE_WEBAPP_LIST,
                f"dashboard returned status {dashboard.status_code}",
            )
        ]

    soup = BeautifulSoup(dashboard.content, "html.parser")
    forms = [
        form
        for form in soup.find_all("form", action=True)
        if "/extend" in form["action"].lower()
    ]
    details = []
    ok = True

    if not forms:
        print("ℹ️ No web apps found on this account.")
        return True, details

    for form in forms:
        action = urljoin(BASE_URL, form["action"])
        domain = action.rstrip("/").split("/webapps/")[-1].replace("/extend", "")
        csrf = form.find("input", {"name": "csrfmiddlewaretoken"})
        if not csrf:
            details.append(
                failure(STAGE_WEBAPP_RENEW, f"{domain} (missing CSRF token)")
            )
            ok = False
            continue

        old_expiry = get_webapp_expiry(soup, domain)
        try:
            response = session.post(
                action,
                data={"csrfmiddlewaretoken": csrf["value"]},
                headers={"Referer": dashboard_url},
                timeout=10,
            )
        except requests.RequestException as error:
            details.append(
                failure(STAGE_WEBAPP_RENEW, f"{domain} (extend request failed: {error})")
            )
            ok = False
            continue
        if response.status_code != 200 or "webapps" not in response.url.lower():
            details.append(
                failure(
                    STAGE_WEBAPP_RENEW,
                    f"{domain} (extend failed, status {response.status_code})",
                )
            )
            ok = False
            continue

        # Post-renewal verification: re-fetch the dashboard and confirm the
        # new expiry is actually readable. Anything else is a failure, not a
        # silent success.
        time.sleep(1)
        try:
            refreshed = session.get(dashboard_url, timeout=10)
        except requests.RequestException as error:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{domain} (post-renewal refresh failed: {error})",
                )
            )
            ok = False
            continue
        if refreshed.status_code != 200:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{domain} (post-renewal refresh returned status "
                    f"{refreshed.status_code})",
                )
            )
            ok = False
            continue
        new_expiry = get_webapp_expiry(
            BeautifulSoup(refreshed.content, "html.parser"), domain
        )
        if new_expiry == "Unknown Date":
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{domain} (could not read new expiry after renewal)",
                )
            )
            ok = False
            continue

        details.append(f"Web App: {domain} ({old_expiry} → {new_expiry})")
        print(f"✅ Renewed web app: {domain} ({old_expiry} → {new_expiry})")

    return ok, details


def renew_scheduled_tasks(session, username):
    """Renew every scheduled task; each task's failure is isolated."""
    tasks_page_url = f"{BASE_URL}/user/{username}/tasks_tab/"
    tasks_api_url = f"{BASE_URL}/api/v0/user/{username}/schedule/"
    print("🗓️ Checking scheduled tasks...")
    time.sleep(1)
    try:
        response = session.get(
            tasks_api_url, headers={"Referer": tasks_page_url}, timeout=10
        )
    except requests.RequestException as error:
        return False, [failure(STAGE_TASK_LIST, f"request failed: {error}")]

    details = []
    if response.status_code != 200:
        return False, [
            failure(STAGE_TASK_LIST, f"fetch failed, status {response.status_code}")
        ]

    try:
        payload = response.json()
    except ValueError:
        return False, [failure(STAGE_TASK_LIST, "response was not valid JSON")]

    tasks = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(tasks, list):
        return False, [
            failure(STAGE_TASK_LIST, "response did not contain a task list")
        ]

    if not tasks:
        print("ℹ️ No scheduled tasks found on this account.")
        return True, details

    csrf_token = session.cookies.get("csrftoken")
    if not csrf_token:
        return False, [failure(STAGE_TASK_LIST, "missing CSRF token")]

    ok = True
    for task in tasks:
        extend_url = task.get("extend_url")
        description = task.get("command") or f"task {task.get('id')}"
        old_expiry = task.get("expiry")
        if not extend_url:
            details.append(
                failure(STAGE_TASK_RENEW, f"{description} (no extend URL)")
            )
            ok = False
            continue

        try:
            result = session.post(
                urljoin(BASE_URL, extend_url),
                headers={"X-CSRFToken": csrf_token, "Referer": tasks_page_url},
                timeout=10,
            )
        except requests.RequestException as error:
            details.append(
                failure(
                    STAGE_TASK_RENEW,
                    f"{description} (extend request failed: {error})",
                )
            )
            ok = False
            continue
        if result.status_code != 200:
            details.append(
                failure(
                    STAGE_TASK_RENEW,
                    f"{description} (failed, status {result.status_code})",
                )
            )
            ok = False
            continue

        # Post-renewal verification: the refresh must succeed, be valid JSON
        # with a task list, and still contain this task. Falling back to the
        # old expiry would silently report an unverified renewal as success.
        time.sleep(1)
        try:
            refreshed = session.get(
                tasks_api_url, headers={"Referer": tasks_page_url}, timeout=10
            )
        except requests.RequestException as error:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{description} (post-renewal refresh failed: {error})",
                )
            )
            ok = False
            continue
        if refreshed.status_code != 200:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{description} (post-renewal refresh failed, status "
                    f"{refreshed.status_code})",
                )
            )
            ok = False
            continue
        try:
            refreshed_payload = refreshed.json()
        except ValueError:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{description} (post-renewal refresh was not valid JSON)",
                )
            )
            ok = False
            continue
        tasks_after = (
            refreshed_payload.get("results")
            if isinstance(refreshed_payload, dict)
            else refreshed_payload
        )
        if not isinstance(tasks_after, list):
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{description} (post-renewal refresh did not contain a task list)",
                )
            )
            ok = False
            continue
        matching = [
            task_after
            for task_after in tasks_after
            if isinstance(task_after, dict) and task_after.get("id") == task.get("id")
        ]
        if not matching or matching[0].get("expiry") is None:
            details.append(
                failure(
                    STAGE_VERIFY,
                    f"{description} (task missing from post-renewal refresh)",
                )
            )
            ok = False
            continue
        new_expiry = matching[0].get("expiry")

        if new_expiry == old_expiry:
            details.append(f"Task: {description} (Already maxed out at: {old_expiry})")
        else:
            details.append(f"Task: {description} ({old_expiry} → {new_expiry})")

    return ok, details


def renew_account(label, username, password):
    """Renew one account; a failure here never propagates to other accounts."""
    session = requests.Session()
    session.headers.update(
        {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    try:
        logged_in, login_details = login(session, username, password)
        if not logged_in:
            return False, login_details
        webapps_ok, webapp_details = renew_webapps(session, username)
        tasks_ok, task_details = renew_scheduled_tasks(session, username)
        return webapps_ok and tasks_ok, webapp_details + task_details
    except requests.RequestException as error:
        return False, [failure(STAGE_UNKNOWN, f"network error: {error}")]
    except Exception as error:
        return False, [failure(STAGE_UNKNOWN, f"unexpected error: {error}")]


def write_log(status, accounts, incomplete, warnings, results):
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    lines = [
        "========================================",
        f"Workflow Run: {timestamp}",
        f"Status: {status}",
        f"Trigger: {os.environ.get('GITHUB_EVENT_NAME', 'local')}",
        f"Repository: {os.environ.get('GITHUB_REPOSITORY', 'local')}",
        f"Branch: {os.environ.get('GITHUB_REF_NAME', 'local')}",
        f"Run ID: {os.environ.get('GITHUB_RUN_ID', 'local')}",
        "Configured accounts:",
    ]
    if accounts:
        lines.extend(f"- {label}: {username}" for label, username, _ in accounts)
    else:
        lines.append("- None")
    if incomplete:
        lines.append("Incomplete or skipped credentials:")
        lines.extend(f"- {item}" for item in incomplete)
    if warnings:
        lines.append("Warnings:")
        lines.extend(f"- {item}" for item in warnings)
    if results:
        lines.append("Renewal details:")
        for label, success, details in results:
            lines.append(f"- {label}: {'SUCCESS' if success else 'FAILED'}")
            lines.extend(f"  - {detail}" for detail in details)
    else:
        lines.append("Renewal details:")
        lines.append("- No complete accounts were configured.")
    lines.extend(["========================================", ""])
    with open(LOG_FILE, "a", encoding="utf-8") as log:
        log.write("\n".join(lines))


def run():
    accounts, incomplete, warnings = get_accounts_from_env()
    results = []
    for label, username, password in accounts:
        print(f"\n{'=' * 50}\nProcessing {label}: {username}\n{'=' * 50}")
        success, details = renew_account(label, username, password)
        results.append((label, success, details))

    any_failed = any(not success for _, success, _ in results)
    if any_failed:
        status = "FAILED"
    elif not accounts:
        status = "FAILED"
    elif incomplete:
        status = "PARTIAL"
    else:
        status = "SUCCESS"
    write_log(status, accounts, incomplete, warnings, results)
    return 1 if status == "FAILED" else 0


if __name__ == "__main__":
    sys.exit(run())
