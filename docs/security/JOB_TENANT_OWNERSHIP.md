# Job tenant ownership persistence

The durable workflow database records an explicit owner for newly created Jobs
when the trusted application boundary supplies a verified
`RequestPrincipal`.

The ownership tuple is:

- `owner_tenant_id`: tenant claim resolved by the configured authenticator;
- `owner_issuer`: exact trusted issuer;
- `owner_subject`: authenticated subject within that issuer.

The three fields are nullable only to preserve pre-migration Jobs. A database
constraint requires either all three values or none. Existing rows are not
backfilled from caller metadata, request payloads, reference IDs, or guesses.
An unowned legacy Job remains unowned and is denied by tenant-scoped
authorization.

`WorkflowRepository.create_job(..., owner_principal=...)` accepts only the
immutable `RequestPrincipal` value object and rejects expired credentials.
Idempotent replays supplied with a principal must match the persisted tenant,
issuer, and subject; cross-owner replay is denied with a non-enumerating
message. The repository also exposes `authorize_job_access` as the shared
resource boundary for Job-scoped operations.

## gRPC enforcement

The bearer interceptor authenticates every non-health RPC and attaches the
principal for the duration of the call. The gRPC adapter
(`grpc/servicers/mixins/job_authorization.py`) then:

1. requires a live principal and the operation's scope **before** resolving
   the durable repository, so an unauthenticated or expired caller never
   touches storage;
2. delegates the tenant/issuer/subject ownership check to the repository;
3. maps every `AuthorizationError` — missing, legacy-unowned or cross-tenant —
   to one `NOT_FOUND` response with the single message
   `Resource not found or access denied`, so callers cannot enumerate
   resources.

Because expiry is re-evaluated inside the authorization check, a token that
expires while a request is being processed is denied at the next authorization
point instead of inheriting the verdict reached when the call was admitted.

## Rollout boundary

The gRPC identity chain above is implemented and covered by tests. It does
**not** by itself complete production rollout to external traffic: deployment
configuration (issuer, audience, claim mapping, key rotation, TLS), a bounded
policy for legacy-unowned Jobs, and shared application-service authorization
for future non-gRPC adapters remain outstanding. Callers that bypass the
authenticated adapter can still create explicitly unowned compatibility
records; do not treat that path as tenant-safe.

No automatic legacy ownership migration is permitted. Any administrative
reconciliation must be explicit, audited, and separately authorized.
