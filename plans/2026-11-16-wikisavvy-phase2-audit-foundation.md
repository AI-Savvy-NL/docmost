# Phase 2, first slice — independent audit foundation

The user asked to continue all remaining independent phases. After the audit
policy questions were dismissed, the user said to continue. The implementation
will use the announced conservative baseline below, not claim the individual
question options were explicitly selected.

## Scope and policy

- Implement basic capture of existing core audit hooks and an owner-only history
  viewer, independent of license state. Advanced audit controls, SIEM and retention
  remain separate later slices.
- Keep login, reads and normal work available if audit persistence fails. Emit
  bounded, sanitized failure alerts and expose workspace-scoped, process-local
  counters to owners. Unattributable failures stay in internal diagnostics.
  This is best-effort recording, not lossless or transactionally coupled auditing.
- Preserve the current workspace ability: only owners have Audit permission.
  Do not add administrator or member access.
- Do not change page read/edit/ancestor/group authorization in this slice.
- Keep history on expiry/removal; do not add automatic deletion, a retention
  scheduler, SIEM forwarding or a production migration/deployment.
- Do not register an Enterprise capability as implemented merely because this
  basic foundation exists.

## Threat model

Members or integrations may influence resource metadata, headers and payloads.
Audit storage must not become a credential or document-content sink. Workspaces
must not see each other's records; a client-supplied workspace identifier is never
an authorization source. Missing context must not fall back to another workspace.

Audit writes come from trusted internal call sites, but their values still need a
bounded allowlist. Keep event/resource identifiers, UUID references, known roles,
known event sources, booleans and bounded counts. Do not store raw request bodies,
headers, free-form document content, credential fields or arbitrary nested data.
Do not persist the raw user-agent header. Validate optional IP addresses.

The first viewer returns only event/actor/resource identifiers and recording
timestamps, not arbitrary historical JSON or headers. Unknown historical event
labels must not be blindly exposed as arbitrary strings.

## File targets and steps

1. Add `apps/server/src/core/audit/audit-record.ts` and tests: validate context
   and payload, sanitize structured changes/metadata, enforce bounds, avoid
   traversing arbitrary properties and preserve caller input.
2. Add `audit.repo.ts`: reuse the existing `audit` table and UUID/timestamp defaults.
   Add workspace-scoped inserts and bounded keyset reads; do not edit generated
   schema declarations or add a migration when the table already exists.
3. Add `audit.service.ts` and tests implementing the existing `IAuditService`.
   Resolve request context through CLS, support explicit background-job context,
   keep actor setters request-local, and handle write failures without leaking
   exception payloads or rejecting the business operation.
4. Add `audit.controller.ts` and tests: authenticated owner with a validated active
   persisted session only, trusted workspace context, bounded cursor/limit DTOs,
   no retention/delete endpoints. The existing global access-token compatibility
   policy is not changed; session-less legacy tokens cannot use this new endpoint.
5. Add `audit.module.ts` and use it in the application's existing no-EE fallback
   position instead of `NoopAuditModule`. Do not enable the private EE loader.
6. Update successful password-login audit context in
   `core/auth/services/auth.service.ts`, with successful/failed-login regressions.
   A public login request has no authenticated interceptor actor yet; do not infer
   arbitrary actor identities from resource IDs.
7. Add independently owned `apps/client/src/features/audit/` query, history page
   and tests. Use workspace-scoped caches and generic safe errors. Replace the
   old audit route with this page, expose it to owners, and leave SIEM routes on
   the independent unavailable-state view.
8. Add isolated PostgreSQL integration coverage using the existing local fixture
   pattern, with no production database access.

## Verification gates

- Malformed/oversized inputs, credential-like fields, nested/free-form metadata,
  getter/prototype tricks, actor/workspace context and caller immutability.
- CLS isolation across concurrent request contexts, explicit job context, valid
  insertion, invalid-event rejection and sanitized persistence-failure counters.
- Anonymous/admin/member/cross-workspace denial, owner access and cursor limits.
- Real PostgreSQL insertion, workspace isolation and keyset pagination.
- UI loading/empty/error/history/failure-warning states, owner-only fetching,
  workspace-scoped cache and no upstream branding or misleading licensed claims.
- Existing login and page-access regression suites; server/client builds and
  broader tests. Distinguish the known baseline backend failures and lint fault.
- Separate correctness/security/coverage self-review before marking this slice
  complete. No production writes are authorized by this local continuation.

## Following slices

Page-permission management must retain access on every restricted ancestor,
nearest-restriction writer semantics and space membership. Its design must cover
concurrency, the existing five-second permission cache and collaboration access
rechecks before mutations are added. Broader security controls and the rest of
Phase 2 are not completed by this audit slice.

## Local implementation status

The foundation is implemented and has real PostgreSQL and full-application HTTP
verification. It is not deployed, and it does not complete Phase 2 or register an
Enterprise capability. See
`2026-11-16-wikisavvy-phase2-audit-verification.md` for commands, evidence and
remaining verification limitations.
