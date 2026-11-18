# Optional independent OIDC pilot

## Approval and limits

The user requested “continue, focus on sso” and explicitly selected
“Approve SSO pilot (Recommended)” on 2026-11-18 after reviewing the concrete
protocol/backend/UI scope. Implement locally, preserving the uncommitted
password/session hardening and OIDC storage foundation. No commit, push,
deployment, license change or real Authentik request is authorized.

Existing accounts only. Optional password login remains available. No email-only
linking, account creation, mandatory SSO, emergency exception, provisioning or
legacy EE unlock. No capability registration or parity claim in this pilot.
Actual issuer/client settings remain unknown and unset; never guess or fetch them.

## Security contract

- Use installed `openid-client` 6.8.2 for code flow, S256 PKCE, state, nonce,
  issuer/audience/time checks and mandatory ID-token signature verification.
  Initial signing support is RS256. Never implement JWT verification manually.
- Trust only explicitly server-allowlisted HTTPS origins. Require discovery,
  authorization, token and JWKS URLs on the configured issuer's origin.
  Reuse DNS-pinned outbound agents, verified TLS, response limits, timeouts and
  no automatic redirects. Never send client secrets to another origin.
- Store client secrets and short-lived proof material with new purposes in the
  existing encryption service; do not change its primitives. Public provider
  projections must never acquire encrypted or plaintext secret fields.
- Browser binding uses an HTTP-only, secure, same-site, host-only cookie.
  Database transactions contain state/browser hashes and an encrypted proof
  payload. Atomically claim an unexpired state once before token exchange;
  failed attempts require restarting, never replaying.
- Bind proof to workspace, provider, configuration revision, callback URI,
  browser and flow. Linking also binds the reauthenticated account's password
  snapshot and live persisted session. Reject changed credentials or revoked
  sessions. No user lookup by an IdP email claim.
- Owner configuration and user linking require a live interactive session and
  password reauthentication. Perform hashing/network work outside account locks;
  recheck account/role/session under the lock before saving.
- Callback finalization rechecks workspace policy, provider revision/enabled
  state and account state in the transaction. Login inserts/signs a persisted
  session atomically under the same account lock as reset. Linking writes only
  its own identity; it does not issue a new session or replace another binding.
- Do not silently bypass existing local MFA or enforced SSO policies. The
  optional pilot refuses unsupported enforced/MFA cases until their own reviewed
  integration exists. Provider disablement blocks new SSO but does not revoke
  existing ordinary sessions.
- Fixed same-workspace post-login/account destinations only. Sanitize errors,
  redact callback query strings from logs and never expose tokens/secret values
  to UI, audit records or test output.

## Implementation sequence

1. Baseline existing OIDC storage and affected session/auth tests.
2. New `core/oidc/oidc-http.ts` and `oidc-protocol.ts`, with failing focused
   protocol/transport tests first. Use a controlled mock issuer and real SDK
   signature validation, not an SDK mock.
3. New `database/migrations/20261118T163000-wikisavvy-oidc-pilot.ts`; extend owned
   types/repository for encrypted configuration, revisions and one-use proofs.
   Preserve existing foundation migration and public storage projections.
4. New `core/oidc/oidc.service.ts` for owner configuration, login/link start,
   callback claim/exchange/finalization and sanitized audits. Add real PostgreSQL
   race/rollback/foreign/replay/session tests.
5. New DTO/controller/module under `core/oidc`; register only the independent
   module in `core.module.ts`. Add allowed-origin configuration access and
   purpose constants; extend callback URL redaction. Require strict Origin on
   mutating browser starts/configuration. Add HTTP cookie/guard/redirect tests.
6. New independent components under `features/oidc/`: login choice, existing
   account linking and owner provider form. Insert alongside existing login
   methods and into `pages/settings/account/account-settings.tsx`, preserving
   unrelated UI. Add loading/empty/error/confirmation/keyboard-oriented tests.
7. Run focused protocol/database/HTTP/client tests, scoped lint/type checks,
   workspace build and broad baseline comparison. Separately self-review
   correctness/security/coverage/UX and record exact results and skipped checks.

## Verification requirements

Exercise successful explicit linking then SSO login, real signed ID tokens,
PKCE/nonce/state/signature/issuer/audience/expiry failures, unlinked identities,
duplicate/cross-workspace bindings, browser mismatch, one-time concurrent
callbacks, changed/disabled provider, deactivated user, reset/revoked-session
during link, owner/interactive-session checks, encrypted proof/secret storage,
signing/storage rollback, TLS/SSRF/redirect refusals and safe UI states.

No production end-to-end success can be claimed from mock-issuer tests. Provider
configuration/real-browser acceptance and production migration locking remain
separate explicitly approved operational work.

## Verified local result — 2026-11-18

The approved optional pilot's protocol, backend endpoints and independent UI are
implemented locally, **uncommitted, unpushed and undeployed**. No real issuer/client
configuration was read, guessed, saved or activated, and no Authentik request or
production access occurred. The previous local password/session slice and OIDC
foundation are preserved; published source remains `915584b8`.

The login page now has an independent SSO choice when an enabled provider exists.
My Profile contains explicit account linking and owner configuration/credential
rotation controls. Password login, existing MFA UI and unrelated legacy controls
remain intact. No license or capability-registry change was made.

| Verification | Result |
| --- | --- |
| Dedicated OIDC runner | 100 passed: 38 storage, 19 real-SDK protocol, 13 transport-policy and 30 PostgreSQL/HTTP pilot cases |
| Password/recovery PostgreSQL/HTTP acceptance | All 64 passed |
| Focused auth/session/encryption/logger/outbound/environment suites | 186 passed |
| Full frontend | 107 files / 1364 tests passed, including 12 new SSO UI cases |
| Client TypeScript | Passed |
| Workspace build | All 5 tasks succeeded; 4 cached on final run |
| Native compiled adapter smoke | Node v24.19.0 accepted a real fixture signature and rejected a tampered signature, outside Jest transforms |
| Scoped SSO/backend lint | Passed, except the pre-existing helper-file import violation described below |
| Full backend | 114 suites passed, 16 failed, 7 skipped; 1579 tests passed, 15 failed, 236 skipped |
| Baseline comparison | Exact 16 failure headings match the preceding OIDC-foundation baseline |
| Diff/runner syntax checks | Passed |

The real-SDK HTTP test exercises start → controlled authorization response →
token exchange/PKCE → RSA signature/nonce/issuer/audience validation → persisted
identity link → subsequent app-session login. A tampered issuer signature reaches
the safe error redirect without an app auth cookie or extra session. These are
controlled network responses, not a real Authentik server.

The HTTP fixture uses the real JWT strategy/guard and persisted sessions for
management/linking permissions. Only throttling is stubbed. Coverage includes
unauthenticated, legacy sessionless, foreign, member, wrong-password and
cross-origin configuration denial; browser mismatch, replay/concurrent callbacks,
expiry, account/password/session/provider/policy changes, no JIT/email linking,
purpose-encrypted storage, cloud verification and session/signing rollback.

The UI checks loading/empty/error/retry states, explicit confirmation, disabled
defaults, cleared sensitive inputs, owner-only controls, focus and keyboard
visibility toggles. An initial exact-label fixture mismatch was corrected for
Mantine's required marker. The final keyboard test uses the component's supported
Space interaction rather than a synthetic click-only event.

## Defects caught before completion

- Fastify preserves Nest's pre-set `200` status when redirect has no explicit
  code. The HTTP test failed; explicit `302` now fixes all callback redirects.
- A proof could expire while waiting behind a row lock. A real
  `pg_blocking_pids` test reproduced acceptance after expiry. Claim now locks
  first and checks database `clock_timestamp()` before deleting/consuming.
- Encoded callback paths could bypass literal URL redaction. The actual Pino
  serializer test failed; decoded-path recognition now strips their query too.
- Migration rollback left enabled records after removing credentials. The
  unchanged rollback assertion now passes: owned providers are disabled first,
  pending proofs/secret columns removed and existing users/sessions preserved.
- New SDK-dependent tests imported ESM before their skip condition under plain
  Jest. Scoped test setup now loads those modules only inside the dedicated
  runner's SDK-compatible environment. All 49 such cases are executed by the
  dedicated runner; the global runner deliberately skips them. No application
  loader workaround or global Jest/dependency change was introduced.

## Separate self-review and remaining boundaries

Separate correctness/security/coverage/UX self-review found no remaining blocker
within the approved local optional pilot. It is a self-review, not an independent
audit. Lock order, transaction propagation, active-session/owner checks, exact
identity binding, revision/state/browser/callback binding, signature checks,
fixed redirects, secret projections and keyboard interactions were reviewed.

- Live Authentik discovery/configuration and a full real-browser sign-in have not
  been tested. No production-ready or deployed SSO claim is made.
- Initial support is RS256 with same-origin HTTPS endpoints. Workspace SSO/MFA
  enforcement and enabled local MFA accounts are refused for SSO authentication;
  there is no implicit policy bypass or emergency exception.
- No automatic signup, unlinking, group/role mapping, provisioning, refresh-token
  persistence, IdP logout/deprovisioning or global token-revocation change.
- One pending browser binding is supported. Failed attempts after state claim
  must restart. Expired records are pruned on another workspace flow start.
- Audit and other post-commit effects remain outside credential/session
  transactions. Provider disablement does not revoke existing app sessions.
- Full server `tsc --noEmit` remains blocked by the known
  `persistence.extension.spec.ts:44` constructor-argument mismatch, also present
  in the prior baseline log. Production source compiled through the build.
- The helper file's existing `import sanitize = require('sanitize-filename')`
  violates its current ESLint no-require rule. Running lint on that file from
  `HEAD` reproduced the same error. The import was preserved; all other scoped
  SSO/backend lint checks passed. Frontend lint retains its documented TanStack
  packaging blocker and was not rerun.
- Migration locking, backup/restore, activation, real-provider acceptance and
  rollout require their own exact operational approval. No commits, tags,
  production migration or signing/license operation occurred.

Operator prerequisites and intended first-use flow are documented in
`docs/wikisavvy-oidc-pilot.md`.
