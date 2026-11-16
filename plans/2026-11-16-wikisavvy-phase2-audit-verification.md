# WikiSavvy audit foundation — local verification

Verified locally on 2026-11-16, with final regression runs completed at approximately
06:50 UTC. No production configuration, data, credentials or license were used.
This report covers the audit-foundation slice only, not all of Phase 2 or
Enterprise parity.

## Implemented boundary

- The no-EE application fallback now provides independently owned audit capture
  and an owner-only history API; the private EE loader is unchanged.
- Existing core hooks can persist allowlisted events and bounded metadata.
  Raw user agents, credentials, free-form content, names/emails and arbitrary
  nested metadata are excluded. Reads do not select historical JSON, IP addresses
  or headers, and unknown historical labels become `unknown`.
- `POST /api/wikisavvy/audit/history` requires an owner in the authenticated
  workspace and a validated active persisted session. Member/admin access is
  denied. Session-less legacy access tokens are also denied here, without
  changing the global legacy-token policy.
- Pagination defaults to 50, accepts 1–100, bounds cursors to 512 characters and
  rejects conflicting cursors. Queries always retain their workspace predicate.
- Capture counters and failure timestamps returned by the API are scoped to that
  workspace in the current process. Missing/invalid workspace context does not
  fall back to any tenant. Internal aggregate diagnostics are not exposed.
- The independent history page covers loading, empty, error/retry, records,
  failure warning, refresh and pagination states. Cache keys include workspace.
  Non-owners neither fetch nor render cached history. The sidebar offers basic
  history to owners without a license. SIEM routes remain unavailable-state views.

## Verification commands and results

Use the project's pinned pnpm 12.16.1, not the broken global launcher. In this
environment the verified launcher was:

```sh
P=/private/var/folders/8z/r3gbbpp17vsfw0vd6v2x6tw00000gn/T/opencode/wikisavvy-tools-20261115/node_modules/pnpm/bin/pnpm.mjs
```

- `node "$P" --filter server exec jest --runInBand core/audit
  core/auth/services/auth.audit-context.spec.ts
  core/page/page-access/page-access.service.spec.ts`: **55 passed**. The 12 real
  integration tests skip in this command without the isolated fixture URL;
  they passed separately below.
- `node scripts/test-wikisavvy-audit.mjs`: **12 passed** against disposable
  PostgreSQL, using the existing UUIDv7, audit and SIEM schema migrations.
  Tests verify sanitized insertion/defaults, tenant filtering even with a foreign
  cursor, forward/back keyset pagination including equal timestamps, historical
  projection and malformed input rejection.
- `node scripts/test-wikisavvy-audit-runtime.mjs`: **28 checks passed** against
  the current compiled server, real PostgreSQL/Redis and real login cookies.
  All 62 migrations applied on a fresh fixture. This checks owner access,
  anonymous/member/admin denial, legacy/API/OAuth/MFA credential rejection,
  invalid pagination, ignored client workspace overrides, foreign-record exclusion
  and session revocation.
- The runtime test injects an insert failure into only its disposable audit table:
  login still succeeds, the workspace failure counter increases, and the raw
  synthetic database error marker does not appear in application logs.
- The complete workspace build passed using the isolated pnpm bin directory with
  `NX_DAEMON=false`; the server was rebuilt and the 28 runtime checks rerun after
  tightening the session boundary.
- Scoped server ESLint passed for audit files, application wiring and the login
  change/tests. `git diff --check` passed. No local pre-commit hook is configured.
- Complete client tests: **103 files / 1,329 tests passed**, including six added
  navigation/route checks for owner-only basic history and unavailable SIEM URLs.
- Complete server tests: **108 suites / 1,500 tests passed; 16 suites / 15 tests
  failed; 2 suites / 17 tests skipped**. The failing-suite set is unchanged across
  this slice and matches the previously reproduced backend baseline, not a green
  backend suite. The skipped 17 include 12 audit and five licensing integration
  tests requiring their isolated fixture runners; the 12 audit tests passed using
  their runner. Licensing integration was not rerun in this slice.
- Client ESLint remains blocked by the previously recorded missing
  `@tanstack/eslint-plugin-query/build/modern/index.js` entry. This unrelated
  dependency/configuration issue was not changed.

Local logs are under the approved session temporary directory:
`/private/var/folders/8z/r3gbbpp17vsfw0vd6v2x6tw00000gn/T/opencode/`, files
`wikisavvy-audit-build.log`, `wikisavvy-audit-client-final.log` and
`wikisavvy-audit-server-final.log`.

The fixture scripts bind published ports only on `127.0.0.1`, generate transient
credentials in memory, and stop only their own uniquely named containers. Cleanup
was verified by label-scoped container listing.

The runtime script requires the locally available pinned Phase 1 runtime image
and PostgreSQL/Redis images, plus a fresh server build. It bind-mounts the current
compiled server into that existing dependency image. This is **not** a newly built
release image, a current-client browser smoke or a deployment.

## Self-review and fixed findings

1. The draft API exposed global capture counters. Four red regressions reproduced
   cross-workspace recorded/failure/rejection/timestamp leakage, then passed after
   counters became workspace-scoped. Invalid-context getter access is covered.
2. The existing session-only decorator checked token type but admitted session-less
   legacy access tokens. A new controller regression reproduced the overly broad
   admission; the new endpoint now requires the active session context established
   by JWT validation. The actual HTTP regression passes.
3. The Mantine table requires `ResizeObserver` in tests. A test-only stub fixed the
   missing DOM fixture; production rendering was not changed for the test runner.

The separate self-review covered correctness, authorization, tenant isolation,
data minimization, safe errors, coverage and semantic UI/state handling. It is not
an independent security audit. No separately licensed EE implementation was
modified or registered as independently implemented.

## Deliberate limits and remaining work

- Capture remains best effort, not lossless or transactionally coupled to business
  writes. Some existing hooks are unawaited; shutdown/write failure can lose events.
  This is not a compliance guarantee or a complete inventory of every user action.
- Counters are in-memory per workspace and per process: restart clears them,
  multiple replicas do not aggregate them, and stored counters are not durable.
  Unscoped rejected events appear only in internal aggregate diagnostics.
- No retention scheduler/deletion, SIEM forwarding or advanced audit controls.
  History is not gated on license state. The implemented-capability registry is
  still empty because this foundation does not establish full capability parity.
- Page-access rules, their cache and collaboration revocation behavior are
  unchanged. Independent permission-management/security slices and Phases 3–7
  remain unfinished.
- No manual browser, keyboard/screen-reader/contrast audit, performance/load test,
  dependency-CVE audit or new release-image build was performed in this slice.
- No commit, push or production deployment. Further production changes require
  separate exact approval.
