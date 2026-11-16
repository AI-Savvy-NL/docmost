# Phase 1 verification and rollout status

Status: deployed at **2026-11-15 20:05 UTC**, with final production verification
at **20:07 UTC**. The combined upgrade was explicitly approved after upgrade
and rollback rehearsals.
The source was subsequently committed and pushed in `1d26d865`. The later audit
release and current recovery target are recorded in
`2026-11-16-wikisavvy-audit-deployment.md`; the evidence below describes the Phase 1
rollout.

## Local acceptance

- Shared crypto: 13 passing tests, including mixed public/private PEM rejection.
- Offline issuer: 3 passing tests.
- Focused server: 7 passing suites / 71 tests. The 5 PostgreSQL integration
  tests run separately and pass, including final-seat concurrency and migration
  down/up.
- Full frontend: 98 files / 1,282 passing tests.
- Full server: 104 passing suites, 16 failing suites, 1 skipped suite;
  1,450 passing tests, 15 failing tests, 5 skipped tests. All failing suites
  reproduce on a pristine HEAD archive; no new failing suite was introduced.
  The old workspace offboarding fixture was repaired.
- Complete workspace build passes using pinned pnpm 12.16.1 and the isolated
  launcher; no global pnpm configuration was changed.
- Final amd64 image: `wikisavvy:0.97.0-license-phase1-20261115`,
  `sha256:89564de1640a94638c706dc546e4a343f71f563eefe3c21e2f5824b14f44ae9e`.
- Final-image HTTP/runtime smoke: 57 assertions pass. Covers real JWT owner
  login, wrong-password rejection, anonymous/member denial, installation,
  invalid replacement preservation, renewal, grace, removal, encrypted storage,
  invitation acceptance/reactivation admission and Community admission.
- Self-review corrected mixed-PEM trust acceptance and hidden removal controls
  for unverifiable stored licenses. Enterprise capabilities remain unimplemented
  and disabled; legacy entitlements remain unchanged.

Lint remains blocked by the existing missing TanStack ESLint plugin entry.
No repository pre-commit hook is configured. Browser editing, visual accessibility,
multi-client collaboration and external dependency vulnerability scanning were
not verified.

## Production preflight exception

Read-only preflight found that production's applied migrations ended at
`20260905T126412-integrations`. The final candidate would also apply these eight
upstream migrations, beyond Phase 1's licensing migration:

1. `20261029T185047-workspace-invitation-expiry`
2. `20261102T160858-space-archive-and-home-page`
3. `20261108T040946-page-cover-position`
4. `20261109T152308-workspace-invitation-message`
5. `20261109T163042-page-verification-updates`
6. `20261109T211226-announcements`
7. `20261110T200644-search-indexing`
8. `20261111T205255-api-key-scopes`

These add metadata and announcements, backfill invitation expiry, change search
triggers and default existing API keys to read+write scopes. They are not merely
licensing tables. The licensing-only cutover was stopped. The user selected
**Review combined upgrade**, with cutover to be approved after rehearsal evidence.
The subsequent “approved” confirmed the backup/rehearsal work. After successful
rollback verification, the user explicitly selected **Approve prd combined
upgrade** for the exact nine-migration application cutover and non-destructive
application recovery described below.

## Backup and upgrade rehearsal

A consistent backup was taken with only the application briefly paused; the
original application resumed healthy. An isolated database restore passed.
Database and Redis production containers were not replaced.

Initial review backup SHA256:
`4bb390dc2918a5bb733ff18cddc515f8020525e4212e159334562038ba79c20b`.
A permission-restricted, checksum-verified off-host copy is retained.

A new final pre-cutover backup also restored successfully and has a verified
off-host copy. Its SHA256 is
`ba0430df5c2dc7b236f1a92adb8206bb8d8aff86c460ce6bbd7ec6927707b840`.

Before the successful retry, a fresh post-migration backup was restore-verified
and copied off-host with matching checksum:
`cd291986c706f09667c68fb2ec93984039aa29a74dd018ce4f3ae7e48fba2cce`.
It is retained in the guest and off-host `wikisavvy-phase1-20261115-retry-final`
backup directories, with directory/file permissions 0700/0600.

The final candidate applied all nine pending migrations and booted against a
production-data restore. All original columns in users, workspaces, spaces,
pages and attachments remained unchanged, as did their counts:
1 user, 1 workspace, 3 spaces, 23 pages, 15 attachments.

One initial local fixture restore failed without retained diagnostic output.
After tightening readiness to wait for PostgreSQL's final server rather than
its initialization server, 10 consecutive isolated full upgrade rehearsals
passed. The initial failure's precise cause was not independently established.

The migration-aware rollback rehearsal passed: the previous application plus
the nine compiled migration files booted against the upgraded restore, retained
all 62 applied migrations and data counts, and returned 401 for four private
APIs. Its original application layers and configuration were preserved.
Rollback image:
`wikisavvy:0.97.0-phase1-rollback-20261115`,
`sha256:f9f14c982f6b1f50710395e37613fcd5df8d764b158404d0ec2ec787a0cb845a`.

SSH access recovered using the same approved identity. Inspection proved the
timed-out staging call had not created its target files before retrying.
A private, bounded SSH control connection was used; no alternate identity or
global SSH configuration was introduced.

## Production cutover and verification

The image archive checksum was verified after transfer. Proxmox guest-exec stdin
is limited to 1 MiB; the transfer used bounded 512 KiB raw chunks and checked any
existing prefix before resuming.

Production Docker identifies the image by OCI manifest digest
`sha256:688216fd9c99cc8d91c0b371aedd885e3e3acb13f0fcb48730b978286c3c7c03`.
The source config digest remains
`sha256:89564de1640a94638c706dc546e4a343f71f563eefe3c21e2f5824b14f44ae9e`.
Its re-exported configuration bytes, runtime configuration and all eight
filesystem layers exactly match the locally tested image.

The first cutover applied all nine approved migrations but hit an overstrict
verification guard inherited from a frontend-only rollout: it expected the old
`pnpm start` command and `/app` directory. The tested full backend correctly uses
`node dist/main` from `/app/apps/server`. Automatic application rollback succeeded
using the retained migration-aware image; upgraded schema/data were preserved.
The guard was corrected to validate the approved image's launcher while retaining
strict non-root user, environment, mounts and host-security checks.

The retry then passed without applying further migrations. Only the application
image reference changed in compose. Final verification confirmed:

- All 62 migrations retained; zero installed licenses.
- Original core data preserved, excluding mutable user activity timestamps from
  the production fingerprint check.
- Counts unchanged: 1 user, 1 workspace, 3 spaces, 23 pages, 15 attachments.
- All 15 existing storage files, uploads volume, application secrets and compose
  environment preserved.
- Original database and Redis containers healthy and unchanged.
- Application healthy with zero restarts; 23 asset checks and six local private
  API-denial checks passed.
- 52 HTTPS checks passed with normal certificate/hostname verification: real
  owner login, wrong-password rejection, anonymous denial, private page/search/
  attachment access, setup/sharing restrictions and canonical redirects.
- Owner licensing status is Community, with no trust configured and no implemented
  capabilities. No real issuer keys or license were installed.
- Secure/HttpOnly/SameSite=Lax cookies and WebSocket 101 upgrade/ping-pong passed.
- An independent external root fetch returned WikiSavvy.

No DNS, Caddy or firewall changes were made. The pre-cutover Caddy configuration
hash and backend probe passed. The post-cutover Caddy SSH check timed out; no
alternate identity was attempted. Its post-cutover configuration hash was not
reverified, while end-to-end HTTPS checks passed.

## Recovery and remaining limitations

Keep the migration-aware rollback image above. A bare original image lacks the
nine applied migration files and is not the verified recovery target. Recovery
retains upgraded schema/data; destructive migration downs were not authorized.

Production uses Community mode intentionally until public issuer trust and a real
license are separately configured. Phase 1 implements licensing infrastructure,
not Enterprise capabilities. The baseline test/lint and browser-verification
limitations listed above remain.
