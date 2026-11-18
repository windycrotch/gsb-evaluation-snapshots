"""Stage 2 — scope validator.

Validates the concrete request (host, port, scheme, path prefix, method, Host header) against
the engagement rules: in-scope path globs, explicit exclusions (e.g. ``/admin/billing/**``,
``/logout``), and permitted methods. Excluded paths win over included ones (deny-by-default).

Every denial is explainable: :class:`ScopeResult` carries the stable identifier of the stage
that rejected the request (``deny_stage``), the rule that matched (``deny_rule``) and, for an
exclusion, the raw ``paths_exclude`` pattern that matched (``excluded_pattern``). The
identifiers are part of the audit contract — callers and dashboards key on them, so they must
never change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..schemas.scope import EngagementScope, PathError, canonical_path
from ..schemas.toolcall import ToolAction

# Stable denial-stage identifiers. Each rejection returns exactly one; they are pairwise
# distinct so a caller can tell "the path was excluded" from "the path was malformed" without
# parsing the human-readable reason.
DENY_HOST_NOT_IN_SCOPE = "host_not_in_scope"
DENY_PORT_NOT_ALLOWED = "port_not_allowed"
DENY_SCHEME_NOT_ALLOWED = "scheme_not_allowed"
DENY_PATH_MALFORMED = "path_malformed"
DENY_PATH_EXCLUDED = "path_excluded"
DENY_METHOD_NOT_ALLOWED = "method_not_allowed"
DENY_HOST_HEADER_NOT_ALLOWED = "host_header_not_allowed"
DENY_PATH_NOT_INCLUDED = "path_not_included"

# Additional stages raised by the pipeline around this validator (kept here so all denial
# stages live in one namespace and cannot accidentally collide).
DENY_SCOPE_EXPIRED = "scope_expired"
DENY_RESOLVED_IP_NOT_ALLOWED = "resolved_ip_not_allowed"
DENY_POLICY_ENGINE = "policy_engine"
DENY_APPROVAL_REQUIRED = "approval_required"
DENY_APPROVAL_DENIED = "approval_denied"
DENY_APPROVAL_ERROR = "approval_error"
DENY_BUDGET = "budget_exceeded"
DENY_PIPELINE_ERROR = "pipeline_error"


@dataclass
class ScopeResult:
    ok: bool
    reason: str = ""
    matched_rule: str = ""  # allow: the paths_include rule that matched
    deny_stage: str = ""  # "" when allowed; else one of the DENY_* identifiers
    deny_rule: str = ""  # "" when allowed; else the scope rule that rejected the request
    excluded_pattern: str = ""  # raw paths_exclude entry, when deny_stage == path_excluded


_RESERVED_TLDS = (".example", ".invalid", ".test")
_HOSTNAME_RE = re.compile(r"[a-z0-9.-]+\Z")


def _host_header_ok(value: str, target_host: str, port: int) -> bool:
    v = value.strip().lower()
    if not v or _CTRL.search(v):
        return False
    name, _, p = v.rpartition(":") if v.count(":") == 1 else (v, "", "")
    if p and (not p.isdigit() or int(p) != port):
        return False
    if name == target_host:
        return True
    # Rampart's own deterministic canaries only: "rampart-*" under a reserved TLD
    return bool(_HOSTNAME_RE.match(name)) and name.startswith("rampart-") and name.endswith(_RESERVED_TLDS)


_CTRL = re.compile(r"[\x00-\x20\x7f]")


def check(scope: EngagementScope, action: ToolAction) -> ScopeResult:
    host = action.target_host.lower()
    hs = scope.host_scope(host)
    if hs is None:
        return ScopeResult(
            False,
            reason=f"host {host!r} not in scope",
            deny_stage=DENY_HOST_NOT_IN_SCOPE,
            deny_rule="scope.in_scope",
        )

    if action.port not in hs.ports:
        return ScopeResult(
            False,
            reason=f"port {action.port} not permitted for {host!r} (allowed: {hs.ports})",
            deny_stage=DENY_PORT_NOT_ALLOWED,
            deny_rule=f"scope.in_scope[{host}].ports",
        )

    if str(action.scheme or "").lower() not in ("http", "https"):
        return ScopeResult(
            False,
            reason=f"scheme {action.scheme!r} not permitted (http/https only)",
            deny_stage=DENY_SCHEME_NOT_ALLOWED,
            deny_rule="scope.scheme",
        )

    # Decisions are made on the canonical path (percent-decoded, ;params/query stripped, '//' and
    # dot-segments collapsed). An exclusion matching ANY decoding stage wins; malformed paths
    # (control chars, not origin-form, over-encoded) are denied outright.
    try:
        canonical = canonical_path(action.path)
    except PathError as exc:
        return ScopeResult(
            False,
            reason=f"malformed request path (fail-closed): {exc}",
            deny_stage=DENY_PATH_MALFORMED,
            deny_rule="scope.path_form",
        )

    excluded_by = scope.path_excluded_by(action.path)
    if excluded_by is not None:
        return ScopeResult(
            False,
            reason=(
                f"path {action.path!r} (canonical {canonical!r}) is explicitly out of scope "
                f"(matched paths_exclude pattern {excluded_by!r})"
            ),
            deny_stage=DENY_PATH_EXCLUDED,
            deny_rule="scope.out_of_scope.paths_exclude",
            excluded_pattern=excluded_by,
        )

    method = action.method or ""
    if method != method.strip() or method.upper() not in hs.methods:
        return ScopeResult(
            False,
            reason=f"method {method!r} not permitted for {host!r} (allowed: {hs.methods})",
            deny_stage=DENY_METHOD_NOT_ALLOWED,
            deny_rule=f"scope.in_scope[{host}].methods",
        )

    # A caller-supplied Host header could route a request for the vetted in-scope IP to a
    # different (out-of-scope) virtual host on the same server. Only the scope-checked target
    # itself, or a Rampart canary ("rampart-*") under an RFC 2606/6761 reserved TLD that cannot
    # be a real vhost (the host-header-injection oracle's probe), is permitted.
    for k, v in (action.headers or {}).items():
        if str(k).strip().lower() == "host" and not _host_header_ok(str(v), host, action.port):
            return ScopeResult(
                False,
                reason=f"caller-supplied Host header {str(v)[:80]!r} is not permitted (fail-closed)",
                deny_stage=DENY_HOST_HEADER_NOT_ALLOWED,
                deny_rule="scope.action.headers[host]",
            )

    pat = scope.path_included(hs, action.path)
    if pat is not None:
        i = hs.paths_include.index(pat)
        return ScopeResult(
            True, reason="path in scope", matched_rule=f"scope.in_scope[{host}].paths_include[{i}]"
        )

    return ScopeResult(
        False,
        reason=f"path {action.path!r} does not match any in-scope pattern",
        deny_stage=DENY_PATH_NOT_INCLUDED,
        deny_rule=f"scope.in_scope[{host}].paths_include",
    )
