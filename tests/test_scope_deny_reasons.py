"""Explainable scope-gate denials: every rejection names the stage and rule that produced it.

The identifiers are an audit contract (dashboards and post-run reviews key on them), so this
file pins the full set, their mutual distinctness, the raw exclusion pattern carried on an
exclusion denial, and the fact that the pipeline preserves all of it in ``checks`` / ``reason``
and in the before-execution audit event.
"""

import pytest

from rampart.audit import AuditLog
from rampart.policy import PolicyPipeline, scope_validator
from rampart.policy.budget import BudgetTracker
from rampart.policy.scope_validator import ScopeResult, check
from rampart.schemas.scope import EngagementScope
from rampart.schemas.toolcall import Decision, ToolAction, ToolCallRequest

SCOPE = """
apiVersion: security-agent/v1
kind: EngagementScope
authorization: {owner: o, authorized_by: c, ticket: T, attestation: ok, expires: "2099-01-01T00:00:00Z"}
scope:
  in_scope:
    - host: "127.0.0.1"
      ports: [8080]
      paths_include: ["/api/**"]
      methods: ["GET", "POST"]
  out_of_scope: {paths_exclude: ["/api/admin/**"], hosts_exclude: []}
  resolved_ip_allowlist: ["127.0.0.1/32"]
limits: {max_requests_per_host_per_min: 100, max_total_requests: 100}
action_policy: {default_tier_ceiling: 1, tier2_requires_approval: true, tier3: deny}
"""


def _scope():
    return EngagementScope.from_text(SCOPE)


def _action(**kw):
    a = {"method": "GET", "target_host": "127.0.0.1", "port": 8080, "scheme": "http", "path": "/api/orders/1"}
    a.update(kw)
    return ToolAction(**a)


def _deny_stage(**kw) -> str:
    r = check(_scope(), _action(**kw))
    assert isinstance(r, ScopeResult) and r.ok is False
    return r.deny_stage


# ------------------------------------------------------------- validator contract
def test_scope_result_keeps_existing_fields():
    r = check(_scope(), _action())
    assert r.ok is True and r.reason == "path in scope"
    assert r.matched_rule == "scope.in_scope[127.0.0.1].paths_include[0]"
    assert r.deny_stage == "" and r.deny_rule == "" and r.excluded_pattern == ""


def test_all_deny_stages_are_stable_and_mutually_distinct():
    stages = {
        "host": _deny_stage(target_host="evil.example"),
        "port": _deny_stage(port=9999),
        "scheme": _deny_stage(scheme="gopher"),
        "malformed": _deny_stage(path="/a%00b"),
        "excluded": _deny_stage(path="/api/admin/users"),
        "method": _deny_stage(method="TRACE"),
        "host_header": _deny_stage(headers={"Host": "other-tenant.com"}),
        "not_included": _deny_stage(path="/other/x"),
    }
    assert all(stages.values()), stages
    assert len(set(stages.values())) == len(stages), stages
    # exact identifiers are the contract — changing one breaks audit consumers
    assert stages == {
        "host": "host_not_in_scope",
        "port": "port_not_allowed",
        "scheme": "scheme_not_allowed",
        "malformed": "path_malformed",
        "excluded": "path_excluded",
        "method": "method_not_allowed",
        "host_header": "host_header_not_allowed",
        "not_included": "path_not_included",
    }


@pytest.mark.parametrize(
    "path", ["/API/admin/users", "/api/%61dmin/users", "//api/admin", "/x/../api/admin/users"]
)
def test_excluded_variant_path_names_the_pattern(path):
    r = check(_scope(), _action(path=path))
    assert r.ok is False
    assert r.deny_stage == "path_excluded"
    assert r.excluded_pattern == "/api/admin/**"
    assert "/api/admin/**" in r.reason


@pytest.mark.parametrize("path", ["/a\r\nHost: x", "/a%00b", "x", "http://evil.example/x", ""])
def test_malformed_path_is_its_own_stage(path):
    r = check(_scope(), _action(path=path))
    assert r.ok is False
    assert r.deny_stage == "path_malformed"
    assert r.deny_stage != "path_excluded"  # never conflated with a configured exclusion
    assert r.excluded_pattern == ""


def test_each_non_exclusion_denial_names_its_rule():
    assert check(_scope(), _action(target_host="evil.example")).deny_rule == "scope.in_scope"
    assert check(_scope(), _action(port=9999)).deny_rule == "scope.in_scope[127.0.0.1].ports"
    assert check(_scope(), _action(scheme="gopher")).deny_rule == "scope.scheme"
    assert check(_scope(), _action(path="/a%00b")).deny_rule == "scope.path_form"
    assert check(_scope(), _action(method="TRACE")).deny_rule == "scope.in_scope[127.0.0.1].methods"
    assert (
        check(_scope(), _action(headers={"Host": "other-tenant.com"})).deny_rule
        == "scope.action.headers[host]"
    )
    assert check(_scope(), _action(path="/other/x")).deny_rule == "scope.in_scope[127.0.0.1].paths_include"


# -------------------------------------------------------------- pipeline contract
class _Resp:
    status = 200
    headers = {}
    body = "ok"
    body_sha256 = "h"
    size = 2
    duration_ms = 1.0


class _Exec:
    def __init__(self):
        self.calls = 0

    def execute(self, action, ip):
        self.calls += 1
        return _Resp()


@pytest.fixture
def pipe(tmp_path):
    scope = _scope()
    audit = AuditLog(str(tmp_path / "audit.jsonl"))
    ex = _Exec()
    p = PolicyPipeline(
        scope,
        audit,
        BudgetTracker(scope.limits),
        ex,
        resolver=lambda h: ["127.0.0.1"] if h == "127.0.0.1" else [],
    )
    return p, ex, audit


def _req(**kw):
    return ToolCallRequest(engagement_id="T", action=_action(**kw))


@pytest.mark.parametrize("path", ["/API/admin/users", "/api/%61dmin/users"])
def test_pipeline_denies_excluded_path_and_audits_the_pattern(pipe, path):
    p, ex, audit = pipe
    r = p.execute(_req(path=path))
    assert r.decision.decision == Decision.DENY and not r.executed and ex.calls == 0
    assert r.decision.checks["deny_stage"] == "path_excluded"
    assert r.decision.checks["deny_rule"] == "scope.out_of_scope.paths_exclude"
    assert r.decision.checks["excluded_pattern"] == "/api/admin/**"
    assert "/api/admin/**" in r.decision.reason
    # the same explanation survives into the tamper-evident audit trail
    ev = audit.read_all()[0]
    assert ev.policy_decision["checks"]["deny_stage"] == "path_excluded"
    assert ev.policy_decision["checks"]["excluded_pattern"] == "/api/admin/**"
    assert "/api/admin/**" in ev.policy_decision["reason"]


def test_pipeline_allows_normal_path_and_reports_the_matched_include(pipe):
    p, ex, _ = pipe
    r = p.execute(_req(path="/api/orders/1"))
    assert r.decision.decision == Decision.ALLOW and r.executed and ex.calls == 1
    assert "scope.in_scope[127.0.0.1].paths_include[0]" in r.decision.matched_rules
    assert "deny_stage" not in r.decision.checks


@pytest.mark.parametrize("path", ["/api/x\r\nHost: evil", "not-origin-form"])
def test_pipeline_marks_malformed_paths_as_such(pipe, path):
    p, ex, _ = pipe
    r = p.execute(_req(path=path))
    assert r.decision.decision == Decision.DENY and not r.executed and ex.calls == 0
    assert r.decision.checks["deny_stage"] == "path_malformed"
    assert r.decision.checks["deny_stage"] != "path_excluded"
    assert "malformed" in r.decision.reason


def test_pipeline_reports_port_and_host_header_stages(pipe):
    p, ex, _ = pipe
    r = p.execute(_req(port=9999))
    assert r.decision.decision == Decision.DENY and r.decision.checks["deny_stage"] == "port_not_allowed"
    r = p.execute(_req(headers={"Host": "other-tenant.com"}))
    assert r.decision.checks["deny_stage"] == "host_header_not_allowed"
    assert not ex.calls


def test_setup_denial_is_explainable_too(tmp_path):
    """Seeded-account logins use the same stage-0-2 checks; their denial must be explainable."""
    p, _ex, audit = _make_pipe(tmp_path)
    req = ToolCallRequest(
        engagement_id="T",
        tool="login",
        phase="setup",
        action=_action(path="/api/admin/login"),
    )
    sent = []
    r = p.execute_setup(req, lambda action, ip: sent.append(action) or _Resp())
    assert not r.executed and sent == []
    assert r.decision.checks["deny_stage"] == "path_excluded"
    assert r.decision.checks["excluded_pattern"] == "/api/admin/**"
    assert "/api/admin/**" in r.decision.reason
    assert audit.read_all()[0].policy_decision["checks"]["deny_stage"] == "path_excluded"


def _make_pipe(tmp_path):
    scope = _scope()
    audit = AuditLog(str(tmp_path / "audit.jsonl"))
    ex = _Exec()
    p = PolicyPipeline(
        scope,
        audit,
        BudgetTracker(scope.limits),
        ex,
        resolver=lambda h: ["127.0.0.1"] if h == "127.0.0.1" else [],
    )
    return p, ex, audit


def test_stage_constants_are_the_single_source_of_truth():
    assert scope_validator.DENY_PATH_MALFORMED == "path_malformed"
    assert scope_validator.DENY_PATH_EXCLUDED == "path_excluded"
    assert scope_validator.DENY_SCOPE_EXPIRED != scope_validator.DENY_PATH_EXCLUDED
