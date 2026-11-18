# Password recovery before SSO — approved local hardening

The user explicitly approved this authentication change on 2026-11-18.
The initial approval excluded commit, push, deployment and Authentik changes.
After local verification, the user explicitly requested “commit push continue”:
commit and push this recovery slice, then continue local security review. This
does not authorize deployment, Authentik changes or additional auth policy changes.

## Evidence and scope

The existing reset service validates its token before entering the password-update
transaction. A synthetic diagnostic using the actual compiled service, mocked
repositories and serialized transactions allowed two concurrent successes for
one token. A separate diagnostic returned a local session with `enforceSso=true`.
These are service-level reproductions, not production exploit tests.

Threats: replay/concurrent use of a valid reset link, cross-workspace confusion,
failure leaving partially changed credentials, and recovery issuing sessions
outside normal SSO/MFA authentication. Security is license-independent.

## Fixed behavior

- A valid reset token succeeds once, including concurrent requests for the same
  account. Expired, consumed, used, wrong-purpose and foreign tokens are rejected.
- The password update, reset-token consumption/invalidation and persisted browser
  session invalidation commit or roll back together.
- Recheck token validity and account state under the transaction's account lock;
  an initial lookup is only a hint, never the final authorization.
- Every successful reset returns `requiresLogin: true`. It never creates a new
  session or auth cookie. Users sign in through normal password/SSO/MFA entrypoints.
- Preserve cloud email-verification behavior, unrelated token types and foreign
  accounts/sessions. Existing post-commit audit, notifications and socket effects
  remain separate from the credential transaction.
- This slice does not promise global revocation of legacy JWTs, collaboration
  tokens, API keys or in-flight logins. Those need their own security review.

## Steps and verification

1. Baseline focused existing auth/token/session tests.
2. Add failing no-auto-login service and real HTTP cookie regressions.
3. Remove automatic reset login in `core/auth/services/auth.service.ts` and
   `core/auth/auth.controller.ts`; retain the existing `requiresLogin` contract.
4. Add isolated PostgreSQL recovery tests using real user, token and session
   repositories. Cover same-token and same-user concurrency, replay, expiry,
   used/wrong-purpose/foreign tokens, disabled accounts, and transaction rollback.
5. Add atomic token consumption to `database/repos/user-token/user-token.repo.ts`;
   make `database/repos/session/user-session.repo.ts` deletion transaction-aware.
   Serialize recovery per account, recheck validity after locking, and keep all
   credential mutations within one transaction.
6. Update `features/auth/hooks/use-auth.ts` sign-in messaging and test loading,
   successful redirect and failure behavior. Do not send SSO users instructions
   implying their new local password replaces provider authentication.
7. Run affected tests, scoped lint/type checks and a workspace build. Perform a
   separate correctness/security/coverage self-review and document remaining gaps.

The integration runner must create only disposable loopback PostgreSQL fixtures,
reject non-test database URLs and redact generated fixture credentials. No
production database or identity-provider access is needed.

## Verified local result — 2026-11-18

At completion of local verification, the approved slice was **not committed,
pushed or deployed**. The subsequent commit/push approval is recorded above.
It does not implement or enable SSO, and deployment remains unauthorized.

- The initial service-level findings were reproduced by real PostgreSQL red tests:
  the same token succeeded twice concurrently, and a session-storage failure left
  an already-committed password change. The unchanged assertions passed after the
  transaction fix.
- Account recovery uses `FOR NO KEY UPDATE`. An additional PostgreSQL test
  demonstrated that `FOR UPDATE` introduced deadlock `40P01` with a concurrent
  replacement-link insertion's foreign-key check. The weaker, sufficient lock
  resolves that cycle while preserving reset serialization and fresh account-state
  checks. Replacement issuance and rejection of the superseded link now succeed
  without a deadlock.
- Token purpose, workspace, account, unused state and strict future expiry are
  checked when consuming the token, after acquiring the account lock. Exact
  expiry and real blocked-request expiry/use/deactivation cases are covered.
- Password, generated-password flag, cloud email verification, reset-token
  invalidation and persisted-session deletion are in one transaction. An injected
  failure after an actual session deletion restores all those changes.
- Reset service/controller never mint a new session or send an auth cookie.
  The client always redirects successful reset responses to sign-in, with neutral
  messaging suitable for password, SSO or MFA authentication.

| Verification | Result |
| --- | --- |
| `node scripts/test-wikisavvy-recovery.mjs` | 33 isolated PostgreSQL/HTTP cases passed |
| Focused recovery/login-audit/token/session Jest suites | 12 passed |
| Client reset handoff tests | 5 passed |
| Scoped backend ESLint | Passed |
| Client TypeScript check | Passed |
| Workspace build | All 5 tasks succeeded; 3 cached |
| Full backend | 113 passed suites, 16 failed, 4 skipped; 1559 passed tests, 15 failed, 118 skipped |
| Failure comparison | Exact 16 failure headings match the previously verified backend baseline |
| Diff/syntax checks | Passed; lockfile and generated database types unchanged |

The PostgreSQL tests include ten deterministic same-token race runs, different
valid links for one account, replay, invalid/foreign/disabled states, foreign
data and unrelated-token preservation, genuine `pg_blocking_pids` lock evidence,
cloud rollback, no-transaction refusal and four HTTP SSO/MFA policy combinations.
They use real repositories and hashing. The HTTP module deliberately stubs
throttle/setup/JWT guards for the public reset route; this is not full application
authentication or rate-limit acceptance.

The cookie plugin's dynamic import initially prevented Jest fixture startup.
VM-module and native-loader attempts were incompatible with the project's Jest
setup. The runner now supplies a scoped CommonJS/`allowJs` transform for the cookie
packages; application dependencies and global Jest configuration are unchanged.
Fixture credentials and connection URLs are redacted.

## Self-review and remaining boundaries

The separate correctness/security/coverage self-review found no remaining blocker
within this slice. This is a self-review, not an independent security audit.

- Notifications, audit and socket/event effects remain post-commit. Their existing
  failure behavior is not made transactional; a post-commit failure can still
  surface after the credential change has committed.
- Broader legacy JWT, collaboration/programmatic-token and in-flight-login
  revocation remain separate security work. No blanket revocation guarantee is
  made here.
- SMTP delivery, full-browser navigation and Authentik/SSO integration were not
  tested. Frontend ESLint remains blocked by its documented TanStack plugin
  packaging issue and was not changed or rerun. No repository pre-commit hook was
  present during verification; commit/push was requested afterward.
- The full backend is **not green**; the reproduced baseline failures remain
  outside this change. No new dependency, schema migration, license/trust change,
  production access or identity-provider write occurred.
