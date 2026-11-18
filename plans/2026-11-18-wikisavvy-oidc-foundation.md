# Independent OIDC storage foundation

## Approved scope

On 2026-11-18 the user selected “Approve foundation (Recommended)”: implement
independently owned provider/identity storage and real PostgreSQL acceptance.
This is local only: no commit, push, deployment, production access, Authentik
change, live login/callback route, login UI, license change or capability
registration. Preserve the existing uncommitted password/session hardening.

The selected initial rollout policy is optional OIDC for existing accounts.
Future self-linking requires password reauthentication plus Authentik proof.
Never link by matching email or automatically create accounts. Bind the exact
issuer and subject; retain explicit password login during the pilot. An IdP
error must not create a session or automatically fall back into authentication.
Mandatory SSO and emergency-login exceptions need a separate reviewed policy.

## Storage contract

- Add `wikisavvy_oidc_providers` and `wikisavvy_oidc_identities`; do not repurpose
  upstream EE provider/account tables or enable their implementation.
- Provider creation stores only public configuration: workspace, exact HTTPS
  issuer and client identifier. Providers are disabled by default; there is no
  enabling method or route in this slice. Client secrets, discovery and token
  exchanges are deliberately absent.
- Identity uniqueness is `(workspace, issuer, subject)`, including across
  different client/provider records for that issuer. One account can have at
  most one subject per provider. Exact case/path/trailing-slash semantics matter:
  do not normalize issuer or subject strings.
- Composite foreign keys bind identity workspace/issuer to its provider, and
  workspace/user to the existing account. Add a namespaced redundant unique
  `(id, workspace_id)` key on users to support the latter. Linked users/providers
  cannot be reassigned across those key boundaries without removing the link.
- Identity writes require a transaction for later proof/state-consumption
  integration. Storage methods are not authorization or proof verification.
- Validate issuer shape and bounded nonempty identifiers. Use deterministic
  byte-sensitive text collation for issuer/subject identity keys. Store no
  passwords, provider tokens, email-based mapping or plaintext client secrets.

## Files and sequence

1. Add failing isolated tests in `core/oidc/oidc.integration.spec.ts` and a
   `scripts/test-wikisavvy-oidc.mjs` runner using a pinned disposable loopback
   PostgreSQL container, private generated fixture password and redacted output.
2. Add `database/migrations/20261118T070000-wikisavvy-oidc-foundation.ts`, owned
   types in `database/types/wikisavvy-oidc.types.ts` and entries in
   `database/types/db.interface.ts`. Do not edit generated `db.d.ts`.
3. Add `core/oidc/oidc.repo.ts` with disabled-provider insertion/scoped lookup and
   transaction-required identity insertion/scoped exact lookup.
4. Cover disabled defaults, valid storage, invalid issuer/identifiers,
   cross-workspace user/provider denial (also raw SQL), mismatched issuer,
   concurrent duplicate identity binding, one-subject-per-account/provider,
   exact case/issuer semantics, rollback, provider/user key immutability, and
   up/down/up preserving existing users/workspaces.
5. Run new PostgreSQL tests, existing password/recovery acceptance, scoped lint,
   type/build checks and broad backend baseline comparison. Separately self-review
   schema constraints, namespace scoping, identifier handling and activation limits.

## Risks and deferred work

The migration adds an index/constraint on the existing users table; production
lock/runtime impact must be reviewed before any separately approved rollout.
Only owned fixture data is removed during tests. The migration is not applied to
production. A schema foundation is not working SSO: no standards validation,
PKCE/state/nonce/callback proof, secret encryption, management permissions,
recent-password reauthentication, logout/provisioning or browser acceptance
is implemented here. HTTPS URL shape validation is not an SSRF policy; no URL
is fetched. Future network access needs explicit issuer trust and transport rules.

## Verified local result — 2026-11-18

The approved storage foundation is implemented locally, **uncommitted, unpushed
and undeployed**. It is not working SSO and does not activate any provider. The
earlier uncommitted password/session slice is preserved.

| Verification | Result |
| --- | --- |
| `node scripts/test-wikisavvy-oidc.mjs` | 38 real PostgreSQL cases passed |
| `node scripts/test-wikisavvy-recovery.mjs` | All 64 existing PostgreSQL/HTTP cases passed |
| Focused recovery/login-audit/token/session suites | 15 passed |
| Scoped new/changed backend ESLint and formatting | Passed |
| Workspace build | All 5 tasks succeeded; 4 cached |
| Runner syntax and diff checks | Passed |
| Full backend | 113 passed suites, 16 failed, 5 skipped; 1562 passed tests, 15 failed, 187 skipped |
| Baseline comparison | Exact 16 failure headings match the preceding password/session verification |

The initial test run failed only because the new modules did not exist. After
implementation, the first 32 database cases passed. Three additional URL-shape
tests then proved that JavaScript's parser accepted extra authority slashes,
embedded newline and empty user-info syntax; the tightened validator made the
unchanged tests pass. It preserves accepted issuer strings exactly.

The final 38 cases verify disabled defaults, no legacy table creation, transaction
requirements, scoped reads, valid storage, malformed inputs, concurrent uniqueness,
cross-provider identity uniqueness, one subject per account/provider, exact
issuer/subject semantics, maximum-length ASCII keys, real foreign-key `23503`,
unique `23505` and check `23514` rejection, rollback, protected key reassignment,
and migration down/up without changing existing account/workspace rows.

Separate correctness/security/coverage self-review found no blocker within this
storage slice. This is a self-review, not an independent security audit.
No upstream EE implementation, encryption primitive, dependency, login screen,
active module registration, capability registry or license was changed.

## Remaining boundaries

- Storage insertion is not proof of identity or authorization. Future linking
  must verify recent password reauthentication, callback proof and account state
  within an approved authenticated flow. Disabled records can be read internally;
  this repository is not a login resolver.
- The actual protocol remains pending: trusted issuer discovery/network policy,
  encrypted client-secret storage, authorization code with PKCE/state/nonce,
  one-time state consumption, validated ID-token claims, callback session
  creation and negative-path/browser acceptance.
- Public URL shape validation neither performs network access nor establishes
  issuer trust. No real Authentik issuer/client details were discovered or guessed.
- First-rollout owner management and account-linking UI remain absent. Optional
  pilot policy is selected; mandatory enforcement, emergency login, provisioning
  and logout/deprovisioning policies remain future work.
- The migration's users-table index/constraint and rollback implications need
  explicit operational review before deployment. Migration rollback would remove
  OIDC records, so it is not an authorized production recovery action.
- Frontend code was unchanged; no new frontend/browser/SMTP/live-provider tests
  were performed. The existing frontend lint packaging blocker and 16 backend
  baseline failures remain outside this slice.
