# Password authentication and session boundaries

## Approval and evidence

On 2026-11-18, after recovery commit `915584b8` was pushed to `origin/main`,
the user explicitly approved this next local authentication slice.
No further commit, push, deployment, production access or Authentik change is
authorized. The earlier recovery implementation and its acceptance remain intact.

Disposable loopback PostgreSQL diagnostics using compiled services, real
repositories, hashing and signed JWTs reproduced:

- A password login paused before session insertion can resume after password
  reset commits and create an active session accepted by `JwtStrategy`, despite
  the old password no longer matching.
- Ordinary password change can fail during other-session removal after the new
  password has committed, leaving the other session active and accepted.

These are local service/database reproductions, not production or full-HTTP
exploit tests. The first requires old-password knowledge and concurrency; the
second requires a storage failure. Known sessionless-JWT compatibility is a
separate existing boundary, not a new finding or part of this change.

## Contract

- Password login, reset and ordinary password change serialize their credential/
  persisted-session mutations on the same account's `FOR NO KEY UPDATE` lock.
- Expensive password checks/hashing remain outside that lock. Before committing,
  re-read the account inside the transaction and reject a changed credential
  snapshot, disabled/missing account or obsolete login email.
- Login's persisted session and last-login update share the transaction. A failed
  insert or token-signing operation must not leave a committed session or
  last-login update. Only committed login success is audited.
- If login commits first, a later reset/password change removes that session.
  If the password mutation commits first, a login using the old snapshot fails.
- Ordinary password update and persisted-session removal commit or roll back
  together. Preserve the existing policy: keep the supplied current session;
  absent a current session, remove all of the account's persisted sessions.
- Preserve cloud email verification checks, foreign accounts/sessions, unrelated
  token types, existing error messages and reset's mandatory normal sign-in.
- Keep post-commit notification/audit/socket effects separate. No blanket
  programmatic/collaboration/legacy JWT revocation, SSO/MFA replacement, account
  linking, emergency-login policy, schema migration or new dependency.
- Signup/setup/invitation behavior is unchanged; transaction support in shared
  session creation remains optional for those callers.

## Implementation and verification sequence

1. Baseline: the just-published recovery's 33 real PostgreSQL/HTTP tests, 12
   focused backend tests and 5 client tests passed again before publication.
2. Extend `core/auth/services/password-reset.integration.spec.ts` with real
   session creation, token signing and JWT strategy validation fixtures. Add
   failing old-snapshot login and ordinary-change rollback tests first. Use the
   existing isolated `scripts/test-wikisavvy-recovery.mjs` runner.
3. Add optional transactions to
   `database/repos/user/user.repo.ts:updateLastLogin`,
   `database/repos/session/user-session.repo.ts:deleteAllExceptCurrent` and
   `core/session/session.service.ts:createSessionAndToken`.
4. In `core/auth/services/auth.service.ts`, lock/re-read/recheck login and ordinary
   password changes and propagate the transaction through every database mutation.
   Keep credential comparison/hashing outside the lock and effects post-commit.
5. Update the login-audit unit fixture for the transaction without weakening its
   identity/order/failure assertions. Add session transaction propagation coverage.
6. Extend real PostgreSQL tests for both concurrency orderings, competing password
   changes, deactivation/email changes while waiting, wrong/missing/foreign
   credentials, preserved current-session policy, actual delete-then-error
   rollback, failed signing/insert, cloud verification and foreign isolation.
   Use explicit barriers and real lock evidence rather than timing assumptions.
7. Run the full affected PostgreSQL/HTTP suite, focused backend tests, scoped
   lint, workspace build/type checks and compare broad backend failures against
   the known 16-suite baseline. Perform a separate correctness/security/coverage
   self-review; record results and remaining limitations here.

## Risks

Account locks add a short critical section to password login; do not hold them
across expensive hashing or external side effects. Use `FOR NO KEY UPDATE`, not
`FOR UPDATE`, to avoid the recovery/replacement-token FK deadlock already proved.
Session insertion and JWT signing must complete before transaction commit; no
successful token/cookie may be returned if commit fails. This is not a new global
session-epoch or request-in-flight revocation guarantee.

## Verified local result — 2026-11-18

The approved password/session slice is implemented locally and remains
**uncommitted, unpushed and undeployed**. The previous recovery slice was committed
and pushed as `915584b85eb509433f4e4659d7008c47efa80b40`; the GitHub `main` ref
matched that revision at 06:16:46 UTC. No production or identity-provider access
occurred.

The two initial regressions failed against the published code exactly as
predicted, while its existing 33 recovery cases remained green. Their unchanged
assertions passed after the minimal implementation, then the broader cases passed
without further application changes.

| Verification | Result |
| --- | --- |
| `node scripts/test-wikisavvy-recovery.mjs` | 64 real PostgreSQL/HTTP cases passed, including all original 33 recovery cases |
| Focused recovery/login-audit/token/session Jest suites | 15 passed |
| Existing client reset handoff tests | 5 passed |
| Scoped backend ESLint and formatting | Passed |
| Client TypeScript check | Passed |
| Workspace build | All 5 tasks succeeded; 4 cached |
| Full backend | 113 passed suites, 16 failed, 4 skipped; 1562 passed tests, 15 failed, 149 skipped |
| Failure comparison | Exact 16 failure headings match the verified recovery baseline |

The new acceptance covers both serialization orderings. A login holding the user
lock first causes reset/change to wait, with `pg_blocking_pids` confirming the
wait; after login commits, the password mutation removes its session and the
signature-verified JWT is denied by the real `JwtStrategy`. If reset/change commits
before a login's old snapshot is rechecked, login is rejected without signing or
inserting a session.

Additional real-lock tests cover password/email changes, deletion/deactivation
flags and loss of cloud email verification. Competing changes using the same
old password allow only one success. Actual session-delete-then-error failures
restore the password and sessions for both current-session policies. Actual
insert-then-error and signing failures roll back login session and last-login
updates without a successful-login audit. Happy paths include case-insensitive
email and verified-cloud login, real signing and JWT strategy acceptance.
Wrong/missing/foreign/disabled credentials, preserved current-session behavior,
foreign data and outstanding reset-token preservation are covered.

## Separate self-review and limits

Correctness/security/coverage self-review found no remaining blocker in the
approved slice. It verified lock order, transaction propagation, rejection before
signing, error behavior, optional transaction compatibility and post-commit
effects. This is a self-review, not an independent audit.

- Database mutations are atomic; post-commit audit, notifications and socket
  effects remain outside those transactions and can still fail after commit.
- This does not change SSO/MFA enforcement, ordinary password change's outstanding
  reset-link policy, sessionless JWT compatibility, signup/setup/invitation
  issuance or collaboration/programmatic-token revocation.
- The tests use real repositories, hashing, signing, session service and JWT
  strategy, but mock mail/audit/socket effects and workspace lookup. The existing
  reset HTTP fixture stubs throttle/setup/JWT guards. New login/change coverage
  is service/database-level, not full-HTTP/rate-limit/SSO acceptance.
- No SMTP delivery, full browser, Authentik interaction or load/performance test
  was performed. Frontend lint retains its documented TanStack plugin packaging
  blocker and was not rerun. No repository pre-commit hook is present.
- The full backend is not green; its unchanged baseline failures remain.
  No new dependency, migration, global package-manager change or EE unlock
  was introduced. Broad security hardening and independent OIDC remain unfinished.
