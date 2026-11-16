# WikiSavvy licensing — Phase 1

Approved scope: implement and verify Phase 1 locally, then deploy to the existing
production WikiSavvy on VM108, as explicitly approved by the user after this plan.
No live cutover before tests, self-review, a fresh verified backup and a
migration-aware rollback. No real signing key generation, changes to upstream
license files, or Enterprise feature claims.

## Policy

- Community requires no license. Enterprise licenses are workspace-bound,
  versioned Ed25519-signed envelopes with an allowlisted capability vocabulary.
- Only independently implemented capabilities are exposed. Phase 1 registers none.
- Public verification keys are supplied by the operator. Issuer private keys are
  read by the offline CLI only, never copied into the application.
- Active, non-deleted member accounts count as seats. Invitations do not.
  Concurrent invitation acceptance and reactivation serialize on the workspace.
  Existing members are never deleted or deactivated by licensing.
- Valid and 30-day grace licenses enforce seat admission. After grace, Community
  remains usable. Licensing does not control login, data reads/exports, MFA, or
  enforcement of existing page restrictions.
- Renewals replace a license atomically. Removing/re-uploading a license cannot
  change its signed expiry. Future-dated or fully expired replacements are rejected
  without changing the existing installation.
- Only workspace owners manage licenses. Raw envelopes are encrypted at rest and
  are never returned by status endpoints or logged.
- Offline revocation and protection against an operator changing code/clock are
  outside the guarantees. AGPL rights and source obligations remain unchanged.

## Steps

1. `packages/wikisavvy-license`: format, validation, signature verification,
   capability vocabulary, grace and seat policy; real-crypto tests.
2. `tools/wikisavvy-license`: offline issuer, bounded claims/key input, exclusive
   mode-0600 output; no private key or license output to the console.
3. `apps/server/src/core/licensing`: trust configuration, encrypted persistence,
   owner management API, metadata/status and transactional seat enforcement.
   Additive migration and typed schema extension; keep legacy licensing separate.
4. Wire seat admission into existing invitation acceptance/reactivation, preserving
   existing role and invitation validation. Test authorization and race behavior.
5. `apps/client/src/features/licensing` and the independent settings page: status,
   seats, dates, safe errors, owner activation/removal, unavailable capabilities.
6. Include the shared package in production image packaging, exclude local
   license/key artifacts from build contexts, document operator setup.

## Verification

- Crypto: tampering, wrong product/workspace, unknown issuer, unsupported key type,
  strict input limits, key rotation, future/expiry/grace boundaries.
- API: owner-only management, cross-workspace rejection, encrypted persistence,
  atomic renewal/removal and metadata without raw license material.
- Membership: pending/deactivated users excluded, capacity checks under a workspace
  lock, over-limit rejection without removing existing users, Community admission.
- UI: loading/error/Community/valid/grace/expired/over-seat states; no false claims.
- Local PostgreSQL migration up/down and transactional integration tests.
- Shared package/server/client builds, relevant and full tests, separate self-review.

The deployment must preserve users, content, uploads, existing secrets and
security/proxy settings. Phase 1 itself introduces only the two additive licensing
tables. Unexpected schema drift or additional pending migrations require review
before cutover.

## Reviewed production scope expansion

Preflight found eight additional upstream migrations pending on production.
The licensing-only rollout was stopped. The user selected a combined upgrade
review, followed by explicit **Approve prd combined upgrade** after ten successful
restored-data upgrade rehearsals and a migration-aware old-application rollback
rehearsal. This separately authorizes the eight reviewed upstream migrations plus
licensing and an application-image-only compose change on the existing VM108.

Fresh restore-verified backups, original data/uploads/secrets, existing database
and Redis containers, and proxy/firewall settings must be preserved. Recovery
retains the upgraded schema/data; destructive migration downs are not approved.
See `2026-11-15-wikisavvy-phase1-verification.md` for the migration list and evidence.
