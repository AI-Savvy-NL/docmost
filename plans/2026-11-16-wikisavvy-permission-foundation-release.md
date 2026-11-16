# Page-permission foundation — release blocked

Status at **2026-11-16 21:20 UTC**: **committed and pushed; not deployed**.
The user requested commit/push/deploy and explicitly confirmed an app-only `prd`
rollout to VM108 / `https://wiki.codesavvy.io`, with fresh verified backup,
off-host copy and application-only rollback. The recorded approval window was
20:58:57–22:28:57 UTC. No production write was executed.

## Source and artifact

- Source: `6982aaea4424a6225ca93d995fa2c4d2553cb996`, pushed to
  `AI-Savvy-NL/docmost` on `main`; remote reference verified.
- Scope: the **unwired** policy foundation documented in
  [the implementation plan](2026-11-16-wikisavvy-page-permissions.md).
  No new permission-management API, UI or capability activation.
- The clean-source linux/amd64 Docker release build passed.
- Local image: `wikisavvy:0.97.0-permission-foundation-6982aaea-20261116`.
- Local image configuration:
  `sha256:1d2e9eb80ad567e828649433d5b5acc97b9efe25c47029b6ee5d4c5ac5c8713b`.

Before commit, the isolated PostgreSQL suite passed all 16 tests and affected
server suites passed 106 tests with 17 integration tests skipped. The previous
full workspace build passed; complete backend failures still match the documented
baseline. No pre-commit hook was configured, and none was bypassed.

## Failed release gate

The complete image was tested without a server bind mount against disposable
local PostgreSQL/Redis, real setup/login/session/audit checks and all 62
migrations.

- Two initial attempts failed during startup or setup/login.
- A diagnostic attempt passed all 28 checks without changing timeout bounds.
- A subsequent sequential comparison failed the acceptance gate:
  **8 of 10 candidate attempts passed**, while two failed during bootstrap.
  The currently deployed baseline image also failed its comparison attempt,
  during setup/login.
- A later instrumented candidate run passed all 28 checks. That does **not**
  override the failed repeat gate or establish that the failures are harmless.

The cause remains unproven. Local emulation/timing or fixture behavior is a
hypothesis, not a verified diagnosis. The Docker engine is aarch64 while the
release image is amd64. Failure diagnostics observed a running application with
startup completion and no detected error/OOM/native-crash markers, but do not
explain every failed attempt.

No source fix, assertion relaxation or timeout increase was made. No accepted
release proof was produced. Image export/staging, production backup and cutover
were not executed.

Sanitized evidence remains in the approved OpenCode temporary directory:
`wikisavvy-permission-repeat-smoke.log`,
`wikisavvy-permission-smoke-repeat-results.json`,
`wikisavvy-permission-smoke-deployed-baseline.log`,
`wikisavvy-permission-smoke-candidate-*.log` and
`wikisavvy-permission-diagnostic-final.log`.

## Production remains unchanged

Read-only guest preflight passed at 21:05:30 UTC:

- Current image: `wikisavvy:0.97.0-audit-bd8c498d-20261116`.
- Healthy application, zero restarts, original database/Redis containers.
- 62 applied migrations; 1 user, 1 workspace, 3 spaces, 23 pages,
  15 attachments and 15 storage files.

Read-only Caddy verification at 21:06:08 UTC confirmed backend health 200;
no proxy reload or configuration change was performed. Public HTTPS health
subsequently returned `status: ok`, with database and Redis both `up`.
The scoped SSH connection is no longer active, and no runtime fixture containers
remain.

## Follow-up

Investigate the intermittent fixture/startup failures with sanitized error and
timing evidence, then obtain reliable release acceptance. Preserve the failed
attempts rather than reporting only successful retries. Revalidate production,
the approved window and a fresh restore/off-host-verified backup before any
cutover. This report does not authorize an unattended retry or enable the
unfinished page-permission feature.
