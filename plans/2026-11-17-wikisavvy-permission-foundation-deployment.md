# WikiSavvy permission foundation — production rollout

Deployed to **https://wiki.codesavvy.io** on **2026-11-17 at 13:46 UTC**.
HTTPS checks passed at 13:46:40 UTC, database/application verification at
13:46:41 UTC and proxy continuity at 13:46:42 UTC. This deploys an unwired policy
foundation, not a complete page-permission management feature.

## Scope and approval

The user requested commit/push/deploy and explicitly confirmed `prd` for source
`91f6cc8896c1488fddda8dc9e460b24a4bd7ffed` on VM108 /
`https://wiki.codesavvy.io`. The initial approved window was
**2026-11-17 06:46:04–08:16:04 UTC**. After a safe first-attempt rollback and an
SSH-agent unlock delay, the user explicitly renewed the same scope for
**13:34:43–15:04:43 UTC**. The successful retry completed within this window.

The approved action is an application-image-only replacement, with brief
application stops for a consistent backup and cutover, isolated restore/off-host
verification, HTTPS/owner-login checks and drift-guarded application-only recovery
to the current audit image if verification fails. No schema migration,
database/Redis recreation, DNS, proxy, firewall, trust or license change is
included.

This release contains an **unwired** independent page-permission policy
foundation and the release-smoke harness correction. It does not expose
permission-management APIs/UI or register an implemented capability. The remaining
Phase 2 work and later phases are unfinished.

## Source and local release evidence

- Source committed and pushed to `AI-Savvy-NL/docmost` on `main`; remote reference
  verified and build snapshot matched clean source.
- All 18 Node script tests passed, including 15 new readiness/argument/redaction
  regressions.
- Exact clean-source linux/amd64 release image built successfully:
  `wikisavvy:0.97.0-permission-91f6cc88-20261117`.
- Source image configuration:
  `sha256:757103bc8cab257495806e190f05345d0d253d6ca5aaafefa8999e6ea75fa734`.
- Production OCI image identifier:
  `sha256:fafe6ad70dc44252d5ad1420fbe87883c4f122281017b5d0588e712172ad4228`.
  Imported runtime configuration, all eight filesystem layers and re-exported
  configuration bytes match the tested artifact. The two identifiers are
  verified representations of the same image, not a substituted build.
- Exported archive: 190,845,625 bytes; SHA256
  `ae0d043fc21096e62c290f4a3cef84010c21ad6039c74b2740dfb777096750a9`.
- Exact-image acceptance passed: baseline, ten sequential candidate runs and
  the 0.15-CPU constrained case, all 28 assertions each without a server bind mount.
  Candidate startup was 3.600–4.615 seconds; constrained startup was 68.824 seconds.
- HTTP request limits and security/session/audit assertions were not relaxed;
  only the application startup budget changed. The prior setup/login failure
  was not causally reconstructed; failed-attempt evidence remains preserved.

The full Docker build includes the workspace build. Full backend/frontend suites
were not rerun for the script-only fix; their previously recorded backend/lint
baseline remains applicable. The permission-policy PostgreSQL suite previously
passed all 16 tests and affected suites passed 106 tests.

## Fresh preflight

Read-only guest checks passed at **06:48:06 UTC**:

- Existing image: `wikisavvy:0.97.0-audit-bd8c498d-20261116`.
- Application healthy, zero restarts; original database/Redis containers healthy.
- 62 applied migrations; 1 user, 1 workspace, 3 spaces, 23 pages,
  15 attachments and 15 storage files.

Read-only Caddy checks passed at **06:48:08 UTC**, with backend health 200.
Configuration/PID were captured for post-cutover comparison; no proxy write was
performed. A separate public HTTPS health read reported database and Redis up.

## First attempt and verifier recovery

The first image import and backup/restore/off-host checks passed. Initial
application-only cutover passed its local checks at 07:26:05 UTC, but the external
verifier failed before making any HTTPS request: a historical temporary fixture
JSON file was missing. The guarded application-only rollback to the audit image
passed at **07:26:13 UTC**, preserving schema and data.

The existing SSH agent subsequently refused signing; the user unlocked the same
approved key. The original window expired while waiting. An expired-window shell
guard did not prevent one subsequent read-only recovery probe because commands
were not chained; no production mutation occurred. The retry procedures check the
renewed window before guest execution.

Read-only recovery located the existing checksum-matched harmless verification
attachment and its page reference, without creating or editing user content.
The recovered fixture is kept in the private durable deployment directory with
0700/0600 permissions, not a temporary-directory dependency. The corrected
verifier retains all 75 checks and adds an explicit returned-page-ID assertion.
It passed all 75 HTTPS checks against the restored audit release at
**13:40:04 UTC**, before the retry.

The retry used fresh guard records, current container identity and a new backup;
no consumed cutover procedure was rerun.

## Fresh retry backup and preservation

A new consistent backup was taken at **13:42:32 UTC** with the original
application briefly stopped, then resumed healthy. Isolated, network-disabled
database restore verified all core counts and all 62 migration names.

The backup is retained in guest/off-host directories named
`wikisavvy-permission-final-retry-91f6cc88-20261117`, with directory/file
permissions **0700/0600**:

- Archive size: **6,206,370 bytes**.
- SHA256: `a1a2389188ab1cbb91a0eea0f697476db3f4f06f9ac665cffa44263d0d1b1362`.
- Off-host archive and individual component hashes verified.
- Preserved: **1 user, 1 workspace, 3 spaces, 23 pages, 15 attachments** and
  all **15 storage files**.

Only the application image reference changed in compose. Original database/Redis
containers, mounts, compose environment, secret configuration, non-root launcher
and host-security settings were preserved. All **62 migrations remained applied;
none was pending or applied by this release**.

Core-data fingerprints passed across cutover, excluding mutable user activity
timestamps. Verification login creates expected session/activity/audit records;
preservation does not mean suppressing these normal application writes.

## Successful production verification

- Application healthy with **zero restarts**.
- **38 asset checks** and seven local anonymous private-API denials passed.
- **75 trusted HTTPS checks** passed:
  - Real owner login and wrong-password rejection.
  - Owner audit history, minimized fields and invalid pagination rejection.
  - Anonymous denial of audit, licensing and private content APIs.
  - Private page/search/attachment access and existing setup/sharing restrictions.
  - Canonical redirects and Secure/HttpOnly/SameSite=Lax session cookies.
  - WebSocket 101 upgrade and ping/pong.
- One post-cutover login audit record was verified in PostgreSQL with its actor,
  allowlisted password source, null raw user-agent and no changes payload.
- Caddy configuration hash and PID matched the fresh retry snapshot; backend
  health returned 200. No proxy reload was performed.
- An independent public health fetch returned `status: ok`, database and Redis up.
- Scoped SSH control connection closed; no runtime fixtures left running.

Licensing remains Community, with zero installed licenses and an empty
implemented-capability registry. Page-permission mutation APIs/UI remain unexposed.

## Recovery and limits

The retained, verified non-destructive application rollback is:

`wikisavvy:0.97.0-audit-bd8c498d-20261116`

Production image identifier:
`sha256:8e5e377c77d14d8a7fc8763db04b2387de61323f8ed2c15af848229d24f62ab6`.

Rollback restores only the reviewed application/compose reference after drift
checks, retaining database/schema, uploads and audit records. It was exercised
successfully on the first attempt; the final retry did not need rollback.

Do not reuse historical guard state or approval windows. The original failed
attempt and its separate backup remain retained. Manual browser editing, visual
accessibility, multi-client collaboration, load testing and a dependency-CVE
audit were not performed. Existing backend/lint limitations and the unfinished
mutation/revocation acceptance gates remain.
