# Page-permission management — approved local completion

The user requested implementation and explicitly approved this plan and its
fail-closed revocation contract on 2026-11-17. No commit, push or deployment is
included. The earlier production rollout remains unchanged.

## Fixed policy and acceptance

- Effective page writers manage only with space membership and traversal through
  all restricted ancestors; no workspace owner/admin bypass.
- New direct restrictions require an effective valid/grace independent capability.
  Existing restriction maintenance/removal and enforcement remain license-independent.
- Preserve public Share. Build independently owned server/client modules, not EE unlocks.
- Fresh authorization checks reject revoked access. Database failures deny/close
  live access; Redis failures cannot authorize stale access. Work already authorized
  before revocation may finish; sent data cannot be recalled.
- Reject stale edits. Protect at least one active, actually accessible human writer
  for the affected page and restricted descendants; do not disclose hidden grants.
- An external account/membership security revocation must not gain a private-page
  bypass or be silently blocked just because it can orphan an existing restriction.
- Do not expose mutation endpoints, UI or the capability until required backend,
  PostgreSQL concurrency and live revocation acceptance passes.

## Work sequence

### A. Mutation persistence and service — implemented and verified locally

- Add an independently owned revision table/migration and types without editing
  generated database types. Keep a monotonic version across local restriction
  removal/recreation; include ancestor/location state in the opaque precondition.
- Add `core/page-permissions/page-permission.repo.ts` and service/tests.
- Use explicit read-committed transactions, workspace-before-hierarchy lock order,
  fresh policy checks, and stable shared principal/membership row locks before
  writing grants. Verify revoke/deactivate races using separate PostgreSQL sessions.
- Validate principals, role and workspace/space eligibility. Check active-human
  writer survivors with actual ancestry semantics, not writer-grant row counts.
- Audit identifiers/roles/counts after commit only, through the existing
  best-effort recorder. Keep failed/rolled-back writes out of audit.

### B. HTTP and live revocation — implemented and verified locally

- Remove cross-request cached authorization allows in the page/space-role decision
  paths; preserve result semantics and transaction support.
- Guard incoming collaboration messages and queued outbound traffic, including
  idle recipients, initial awareness/sync and cross-instance broadcasts.
- Hocuspocus `connected` runs after initial awareness/queued traffic. Install the
  send guard before initial sends, using verified library integration rather than
  assuming the late hook is sufficient.
- Bound queued traffic and fail closed on database/check failures. Redis remains
  an acceleration/notification mechanism, not authorization truth.
- Trace tree/base realtime delivery and remove unsafe cached unrestricted shortcuts.
- Prove descendant/group changes, active/idle connections, downgrades, Redis outage,
  database outage and startup paths with the real library and local PostgreSQL.

### C. API and independent modal — implemented and wired after A/B acceptance

- Add session-authenticated controller/module/DTOs under `core/page-permissions/`.
- Return only management state and minimum entitlement flags, not owner-only/raw
  license metadata. Reject foreign identifiers and invalid/stale requests.
- Add `apps/client/src/features/page-permissions/` types/query/modal and a separate
  entry in `features/page/components/header/page-header-menu.tsx`.
- Cover inherited/direct restrictions, principal selection, loading/empty/error
  states, conflict refresh and loss of management access. Preserve public Share.

### D. Acceptance and self-review — completed with repository baseline exceptions

- PostgreSQL inheritance/group/tenant/principal/concurrency/last-writer/revision/
  license-expiry regressions and sanitized post-commit audit tests.
- Real multi-client collaboration and HTTP acceptance, not just mock hooks.
- Frontend interaction/state/accessibility tests and affected existing regressions.
- Complete workspace build after final test changes; distinguish known baseline
  backend failures and frontend lint dependency issue.
- Separate correctness/security/coverage/user-impact self-review.
- Register `wikisavvy.page-permissions` only after complete independent acceptance.

## Evidence

The deployed foundation is recorded in
[the prior plan](2026-11-16-wikisavvy-page-permissions.md).
Local implementation is complete. Only `wikisavvy.page-permissions` is registered;
this is not completion of the remaining Enterprise phases or a production rollout.
All changes remain uncommitted and unpushed. The new revision migration has been
applied only in disposable test databases, not production.

### Final verification — 2026-11-17

| Check | Result |
| --- | --- |
| `node scripts/test-wikisavvy-page-permissions.mjs` | 68 passed, using pinned disposable loopback PostgreSQL and Redis |
| Focused backend policy/effects/authentication/transport/Redis/tree suites | 59 passed across 6 suites |
| Offline license package tests | 13 passed |
| Licensing service tests | 7 passed |
| Affected client permissions/licensing/audit/routes suites | 54 passed across 8 suites; includes 17 permission-modal/notice tests |
| Client TypeScript check | Passed |
| Scoped backend ESLint | Passed |
| Full workspace build after final test additions and capability activation | All 5 build tasks succeeded |
| Full backend suite | 112 passed suites, 16 failed, 3 skipped; 1549 passed tests, 15 failed, 85 skipped |
| Baseline comparison | Exact same 16 failure headings reproduced from committed `de0eb0c0` in a temporary archived snapshot; working tree never stashed or discarded |
| `git diff --check` and fixture-runner syntax check | Passed |

The full backend run is **not green**. Its baseline failures remain outside this
change. Frontend ESLint is blocked before checking files because the already
declared `@tanstack/eslint-plugin-query@5.94.4` has no `build/modern/index.js`.
The official exact-version archive, downloaded anonymously and integrity-checked,
also lacks built files. Repair stopped without modifying dependencies or lint
configuration. No repository `.githooks/pre-commit` was available to run.

### Verified behavior and self-review

- Authenticated Nest/Fastify requests use the actual JWT guard/strategy and real
  permission repositories. Missing/revoked sessions, foreign pages, invalid DTOs,
  stale edits, account deactivation and next-request grant/membership revocation
  are rejected. The actual module dependency graph is exercised separately.
- Real signed and encrypted valid/grace licenses permit new restrictions. After
  actual stored-license expiry, maintenance/removal still work and new creation
  is denied. Other signed capabilities remain inactive.
- PostgreSQL tests verify conflicting managers, ABA and ancestor preconditions,
  hidden restricted descendants, active accessible human writers and genuine
  lock blocking for group/account/space-membership/archival races.
- Real Hocuspocus authentication, queued initial traffic, awareness, inbound Yjs
  writes, idle outbound recipients and Redis proxy egress are tested. Database
  pool/check failure, check timeout and unavailable Redis publication fail closed.
  Authorization uses a fresh repeatable-read snapshot to prevent mixing a
  pre-move space role with post-move restrictions.
- Outbound checks can restrict access but never promote a connection's write
  state. Only the inbound message's fresh check can enable writes. Safe permission
  notices update the editor, and revocation clears both UUID and slug aliases.
- Traffic is capped at 256 queued frames and 100 MiB per direction, matching the
  existing WebSocket frame ceiling rather than imposing a new 1 MiB page limit.
- Tree/comment content uses fresh active-account, space-membership and ancestry
  filtering, never a cached unrestricted-space shortcut. Post-commit tree refreshes
  contain no grants, names or page content. Audit events contain IDs/roles/counts,
  and audit/notification rejection does not undo committed permissions.
- The separate modal covers inherited/direct states, principal selection,
  loading/empty/error, conflict reload, denied access, last-writer prevention,
  removal confirmation and pending-save controls. Public Share remains unchanged.

This was a correctness/security/coverage/interaction **self-review**, not an
independent audit. DOM interaction tests are not a full browser/network end-to-end
or multi-node chaos test. Optional separately licensed base realtime is absent in
this build; it was not unlocked or implemented.

### Operational boundary

The approved in-flight-work contract and database load/availability trade-off
remain in force. Mutation checks serialize per workspace and share-lock principal
rows; live frames require fresh database work. Already-authorized work can finish
and previously delivered data cannot be recalled.

No commit, push, production access, deployment or production migration was
performed. A later rollout needs its own approval and migration/backup verification;
earlier consumed production approvals and rollout scripts are not reusable.
