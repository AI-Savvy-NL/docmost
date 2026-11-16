# WikiSavvy audit foundation — production deployment

Deployed to **https://wiki.codesavvy.io** on **2026-11-16 at 17:10 UTC**.
Final application verification passed at 17:10:51 UTC, with proxy read-back at
17:11:48 UTC. This release deploys the UI cleanup and basic audit foundation,
not all of Phase 2 or the remaining Enterprise phases.

## Source and artifact

- Baseline commit: `1d26d865128e35f1bfc6ddc5dd42b7ecabab79c2`.
- Deployed source: `bd8c498d3197ec961664aae813edf507e18ae7e6`, pushed to
  `AI-Savvy-NL/docmost` on `main`.
- Image tag: `wikisavvy:0.97.0-audit-bd8c498d-20261116`.
- Source image configuration:
  `sha256:26de7afd12d72845a3f229ef4a4d09e1e2516b45714431978b7a0116266515ee`.
- Production OCI image identifier:
  `sha256:8e5e377c77d14d8a7fc8763db04b2387de61323f8ed2c15af848229d24f62ab6`.
- Exported archive SHA256:
  `86980ce22afd5dacb7bfe08f54ae4aaec9e607542d5c37c66b9ed49f0ef12a04`.

The imported runtime configuration, all eight filesystem layers and re-exported
configuration bytes match the locally tested artifact. The differing source
configuration and production OCI identifiers are verified representations of
the same image, not a substituted build.

The first release build caught an unsupported `exact` option in a navigation
test. The correction uses an anchored accessible-name regular expression and
changes no runtime application behavior. The corrected complete amd64 image
built successfully and passed 28 real application/session checks without a
server bind mount.

## Approval and guarded rollout

The user explicitly approved the corrected revision for an app-only `prd`
deployment. An earlier time window expired while awaiting confirmation; its
guard stopped before staging. The renewed window was
**16:41:37–18:11:37 UTC**, and all deployment actions completed within it.

Fresh preflight verified the expected Phase 1 application, unchanged compose
configuration, healthy database/Redis and an exact match between all 62 applied
migrations and source migration names. **No migration was pending or applied.**

Only the application image reference changed in compose. The original database
and Redis containers, compose-supplied environment, secret configuration, uploads
volume, non-root launcher and host-security settings were preserved. No DNS,
Caddy, firewall, issuer-trust or installed-license configuration changed.

## Backup and preservation

A consistent backup was taken with the existing application briefly paused,
then resumed healthy. An isolated, network-disabled database restore verified
the row counts and all 62 migrations.

The fresh backup is retained in the guest and off-host directories named
`wikisavvy-audit-bd8c498d-20261116`, with directory/file permissions **0700/0600**.
The off-host archive and its component hashes were verified:

- Size: **6,206,134 bytes**.
- SHA256: `db54843cfd42d99a26140cf8795d61703fbe402940bf15d77b3f1b20edcfca19`.
- Preserved: **1 user, 1 workspace, 3 spaces, 23 pages, 15 attachments**.
- All **15 existing storage files** preserved.

Core-data fingerprints were checked across cutover, excluding mutable user
activity timestamps. Verification login creates normal session/activity records
and a new audit event; preserving existing data does not mean preventing these
expected application writes.

## Production verification

- Application healthy with **zero restarts**.
- **38 asset checks** and seven local anonymous private-API denials passed.
- **75 trusted HTTPS checks** passed, including:
  - Real owner login and wrong-password rejection.
  - Owner audit history, minimized response fields and invalid pagination denial.
  - Anonymous denial of audit, licensing and private content APIs.
  - Private page/search/attachment access and existing setup/sharing restrictions.
  - Canonical redirects and Secure/HttpOnly/SameSite=Lax session cookies.
  - WebSocket upgrade and ping/pong.
- A real login audit event was verified in PostgreSQL with its actor, allowlisted
  password source, null raw user-agent and no changes payload.
- Caddy configuration hash and process ID matched the pre-cutover snapshot;
  Caddy-to-backend health returned 200. No proxy reload was performed.
- A separate web fetch of the public health endpoint returned `status: ok`,
  with database and Redis both `up`.
- Licensing remains Community, with zero installed licenses, no configured issuer
  trust and an empty implemented-Enterprise-capability registry.

Local acceptance also passed: 1,329 frontend tests, 12 audit PostgreSQL tests,
five licensing PostgreSQL tests, 13 crypto tests, three issuer tests and the
complete workspace/image builds. The known backend failures and frontend lint
blocker remain documented in the local verification report.

## Recovery and limits

The prior Phase 1 application image is retained for non-destructive application
rollback:

`wikisavvy:0.97.0-license-phase1-20261115`

Production image identifier:
`sha256:688216fd9c99cc8d91c0b371aedd885e3e3acb13f0fcb48730b978286c3c7c03`.

The reviewed rollback restores only the application image/compose reference
after drift checks; it retains schema, existing data and recorded audit history.
Rollback was not needed. Never rerun consumed cutover helpers or restore old
configuration without checking current state. This deployment approval is not
standing authorization for future production changes.

Audit capture is best effort and counters remain process-local. SIEM, retention,
advanced controls and the remaining implementation phases are unfinished.
Manual browser editing, visual accessibility, multi-client collaboration,
load testing and a dependency-CVE audit were not performed.
