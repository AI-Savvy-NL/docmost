# Phase 2 — independent page-permission management

Local continuation after the audit deployment. The user approved:

- Effective page writers may manage permissions, but only with space membership
  and access through every restricted ancestor. Workspace roles confer no bypass.
- Only creating a new direct page restriction requires a valid/grace independent
  WikiSavvy license. Authorized maintenance and explicit removal of existing
  restrictions remain available after expiry. Enforcement never depends on a
  license being present.
- New independent server/client modules, a separate Page actions → Page permissions
  modal, transactional updates, conflict/last-writer safeguards and real
  PostgreSQL/WebSocket verification. Existing public sharing remains untouched.

No commit, push or new production deployment is included in this continuation.

## Release follow-up — 2026-11-17

The user subsequently requested commit/push/deploy. The policy foundation and
smoke-harness correction were deployed as source `91f6cc88` at 13:46 UTC after
renewed explicit production approval, fresh restore/off-host-verified backup and
75 HTTPS checks. See the
[deployment report](2026-11-17-wikisavvy-permission-foundation-deployment.md).
The foundation remains unwired: mutation services, API/UI, capability registration
and the remaining acceptance gates below are **not complete or enabled**.

## Progress — 2026-11-16 18:50 UTC

Step 1 is implemented and verified locally as an **unwired policy foundation**.
Steps 2–5 remain incomplete. There is no mutation service, controller/module
wiring, modal, migration or capability registration in this slice; production
remains unchanged.

- `WikisavvyPagePermissionPolicy` requires a transaction, locks the initial space,
  re-reads the page, rejects location drift and checks fresh active-user,
  workspace-scoped active-space, membership and effective-writer state.
- The two repository methods below now execute on an optional transaction and
  bypass both cache reads and writes when it is supplied. Ordinary cached calls
  and explicit `skipCache` calls retain their previous behavior.
- New direct restrictions check effective license features after the workspace
  lock; existing direct restriction maintenance does not consult licensing.
- Separate self-review caught a missing space/workspace association check. A real
  PostgreSQL regression first demonstrated an erroneous allow, then passed after
  adding the scoped `SpaceRepo.findById` lookup. Missing/deleted/archived space
  guards are covered by unit tests.

Verification completed after the final test addition:

| Check | Result |
| --- | --- |
| `node scripts/test-wikisavvy-page-permissions.mjs` | 16 PostgreSQL tests passed; disposable loopback-only fixture |
| Policy unit suite | 30 passed |
| Affected policy/access/collaboration/audit/licensing suites | 106 passed, 17 integration tests skipped |
| Complete backend Jest run | 109 suites / 1,530 tests passed; 16 suites / 15 tests failed; 3 suites / 33 tests skipped |
| Complete workspace build | Passed |
| Scoped server ESLint, fixture-script syntax, `git diff --check` | Passed |

The full backend failing-suite set matches the recorded deployed baseline, not a
clean test run. Separate PostgreSQL execution covers the new integration tests
that the ordinary environment skips. The pre-existing frontend TanStack ESLint
plugin issue remains; no frontend code changed or rendered UI was tested.

Final logs are in the approved OpenCode temporary directory:
`wikisavvy-permission-foundation-server-final.log`,
`wikisavvy-permission-foundation-build-final.log` and
`wikisavvy-permission-foundation-affected.log`.

### Self-review boundaries and remaining blockers

Reviewed the new policy, both repository diffs, their query/cache helpers,
workspace-scoped space lookup, unit/integration tests and fixture runner. This
was a self-review, not an independent audit or full application security audit.
No additional foundation fix was identified after the tenant-association fix.
Do not interpret that as approval to expose mutations.

- The waiting-writer PostgreSQL regression verifies an earlier ACL change under
  the same hierarchy lock and default transaction isolation. It does not prove
  serialization with account deactivation or group/space-membership changes
  between the policy reads and the eventual mutation commit. The mutation layer
  must establish and test the isolation, shared locking and lock-order contract;
  do not assume re-reading after a lock gives fresh state under repeatable-read
  snapshots.
- Last-active-accessible-writer validation, stale revision conflicts, principal
  validation and sanitized post-commit audit capture are not implemented.
- Five-second HTTP cached decisions and asynchronous Redis rechecks remain.
  Idle outbound WebSocket recipients, descendant/group revocation and Redis/DB
  failure behavior have not passed live acceptance. An inbound hook alone is
  insufficient.
- The implemented-capability registry remains empty. Licensing is mocked in
  policy tests (the workspace database lock is real); these tests do not prove
  an end-to-end licensed management feature.

Next: implement and verify the independent mutation persistence/service without
wiring it, then resolve the revocation gates before adding the API or UI.

## Threat model and invariants

Clients can supply foreign page/principal identifiers, stale revisions and
concurrent mutations. Managers can lose access while a dialog is open. Cached
allows, empty groups and asynchronous live-editor rechecks must not turn a
permission change into an access leak or a lockout.

- Authenticate workspace/session context, then fetch current user/page state.
- Reuse the core all-ancestor traversal and nearest-restricted-writer semantics.
  A space reader with an explicit effective page-writer grant can manage that page;
  a space/workspace administrator without effective page access cannot.
- Reauthorize inside the mutation transaction, after the same per-space hierarchy
  lock used by page moves. Re-read location after locking and reject drift.
- Never consult or populate cross-request permission caches during transaction
  authorization. Existing non-transaction callers keep their current behavior
  until a separately verified revocation design replaces it.
- Do not use raw writer-row counts as a last-active-writer guarantee: group rows
  can be empty and direct users can be disabled or unable to traverse ancestors.
- A new direct restriction on an already restricted descendant still counts as
  creation. Determine direct state from the database, not a client action flag.
- Check effective independent capabilities, not just raw signed claims. The
  implemented-capability registry stays empty until full feature acceptance.
- Existing restriction maintenance must not depend on a working license store.
- Audit only safe identifiers/roles/counts after commit, using the existing
  best-effort recorder; never persist page content, principal names or credentials.

## Incremental steps

### 1. Transaction-safe policy foundation — first implementation step

- Extend only `PagePermissionRepo.canUserEditPage` and
  `SpaceMemberRepo.getUserSpaceRoles` to accept a transaction. Transactional
  evaluation bypasses cache and executes on that transaction.
- Add `core/page-permissions/page-permission-policy.ts` and tests. Validate
  authenticated workspace, active account, page lifecycle, locked current location,
  actual space membership and effective writer access. Gate new direct restriction
  creation with the independent licensing service and its workspace lock.
- Add isolated PostgreSQL tests for real core queries, direct/group grants,
  nested ancestors, conflicting roles, transaction visibility, stale cached allows
  and lock/revocation interleavings.
- Do not wire an API, modal or implemented-capability flag in this step.

### 2. Mutation persistence and conflict/lockout safeguards

- Add an independently owned repository/service and DTOs under
  `core/page-permissions/`.
- Define a bounded revision/precondition protocol; reject stale edits with 409
  rather than overwrite another manager's change.
- Validate active same-workspace users/groups and actual space access. Preserve
  at least one active, accessible writer during manager-initiated changes.
- Cover creation, grant, role change, revoke and explicit local-restriction removal.
  Do not treat removing a local restriction as removing an ancestor's restriction.

### 3. Revocation enforcement gate

- Verify HTTP access after a committed change and active WebSocket read/write
  access, including descendant pages, group removal, Redis failure and DB failure.
- Current HTTP decisions have a five-second cache; Redis collaboration rechecks
  are fire-and-forget. Neither proves immediate revocation.
- The installed Hocuspocus hooks run before inbound sync updates, but an inbound
  check alone does not protect outbound broadcasts to an idle revoked connection.
  Resolve this explicitly before exposing mutations; document the actual
  revocation/availability contract rather than invent an instantaneous guarantee.
- Preserve search, export, attachments, tree events and collaboration authorization.
  Do not widen unrelated security behavior while fixing these boundaries.

### 4. API and independent UI

- Add session-authenticated, workspace-scoped API/controller/module only after the
  preceding gates pass.
- Add `features/page-permissions/` types/query/modal and an entry in
  `features/page/components/header/page-header-menu.tsx`.
- Derive UI permissions from the backend; preserve public Share controls and
  separately licensed source. Cover loading/error, inherited/direct state,
  conflicts, confirmation and revoked access.
- Expose only minimal capability availability to non-owner managers, not raw
  license material or owner-only licensing metadata.

### 5. Acceptance and self-review

- Run targeted tests before/after each small change, real PostgreSQL and live
  collaboration acceptance, affected security/content regressions, complete
  workspace type-check/build and broader tests.
- Run the complete build after the last test addition, not just Vitest.
- Separately review correctness, authorization, disclosure, concurrency, license
  expiry, user impact and coverage. Distinguish the known backend/lint baseline.
- Register `wikisavvy.page-permissions` only after its complete independent
  backend/UI and acceptance gates pass. A passing policy helper is not parity.
