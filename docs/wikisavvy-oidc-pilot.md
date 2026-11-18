# Optional independent OIDC pilot

This is a local pilot, not a deployed or live-Authentik-verified feature. It uses
the independently owned `core/oidc` backend and `features/oidc` UI, not the legacy
EE SSO implementation. Existing password login remains available.

## Prerequisites

- A verified HTTPS application URL and HTTPS identity-provider endpoints.
- An explicit server allowlist of canonical issuer origins:
  `WIKISAVVY_OIDC_ALLOWED_ORIGINS`. It is empty by default, so no issuer traffic
  is permitted. For the selected Authentik host, a future reviewed configuration
  would allow `https://auth.codesavvy.io`. This is an origin, not a complete
  issuer URL.
- A confidential authorization-code client supporting S256 PKCE, RS256 signed ID
  tokens and `client_secret_post` token authentication.
- Discovery, authorization, token and JWKS endpoints on the configured issuer
  origin. Cross-origin endpoints and redirects are refused.
- The exact issuer and client details from the provider configuration. Do not
  guess an application slug or treat the bare Authentik host as the issuer.
- A live persisted WikiSavvy session and the account's current local password.
  The workspace owner configures providers. Members link only their own accounts.

Server-to-provider requests use DNS-pinned outbound agents and normal certificate
verification. Existing private-network policy still applies; the origin allowlist
does not override it. Certificate failures are errors, not reasons to disable TLS.

The optional pilot refuses workspaces enforcing SSO or MFA and accounts with
enabled local MFA, rather than silently bypassing those policies. Integrating
those policies requires a separate reviewed change. Cloud account email
verification is preserved; an IdP email claim never verifies or changes it.

## Intended first-use flow

Production configuration, migration, deployment and Authentik writes require
separate approval of the exact environment, resources, role and UTC window.
The steps below describe the UI; they are not approval to perform those actions.

1. Review/apply the owned migrations in an approved environment. The foundation
   adds a composite users key, so its locking/runtime impact needs rollout review.
2. Configure the application HTTPS URL and explicit issuer-origin allowlist.
3. In **My Profile → Single sign-on**, the owner opens **Configure SSO provider**.
   The form displays the exact callback URL to register with the IdP:
   `/api/oidc/callback` on the configured workspace origin.
4. Enter the exact issuer, client identifier and client secret. Confirm the
   owner's current password. New providers are disabled unless the owner
   explicitly selects **Enable optional SSO**.
5. Enabling verifies discovery and supported endpoint/signing configuration. It
   cannot prove a client secret is correct until an actual authorization flow.
6. Each existing user selects **Link account**, confirms their current password
   and completes authentication at the IdP. Linking does not create a new account,
   issue a new app session or replace somebody else's identity binding.
7. On the login page, the linked user can choose **Sign in with SSO**. A successful
   callback creates a normal persisted WikiSavvy session and redirects to Home.
   Normal password login is still an explicit, separate choice.

Owner edits keep issuer/client identity keys fixed. An empty secret on edit
preserves the encrypted secret; supplying a new secret rotates it. Configuration
updates invalidate pending flows through a revision change. Disabling a provider
blocks new SSO attempts, not existing application sessions.

## Protocol and failure behavior

The flow requests only `openid`; account resolution uses exact workspace,
issuer, subject and linked provider, never email or IdP role/group claims.
There is no automatic signup, provisioning, unlinking, forced SSO, emergency
exception, refresh-token storage or IdP single/back-channel logout in this pilot.

The installed `openid-client` library validates PKCE, state, nonce, issuer,
audience and time claims. Explicit signature verification is enabled and the
pilot accepts RS256 ID tokens. Access/ID tokens returned by the provider are not
stored or sent to the client UI.

A short-lived HTTP-only, secure, same-site, host-only cookie binds an attempt to
its browser. The database stores hashes and purpose-encrypted proof material.
Each state is claimed once, with expiry rechecked after its row lock. Attempts
that fail after claiming state must restart; replay is not a retry mechanism.
Expired proof records are pruned when another flow starts in that workspace.
Only one pending browser attempt is supported: starting another can invalidate
the earlier browser binding.

Callback success/failure redirects to fixed local destinations without code/state
in the destination URL. Errors do not issue an auth cookie or automatically log
in with a different method. Callback query strings are redacted in request logs,
including encoded route paths. Audit records contain only event/user/provider
identifiers and safe status metadata.

Password confirmation is rechecked under the account lock. Linking fails if its
password changes, session is revoked, account is disabled or provider changes
before completion. Session creation and last-login writes commit/roll back
together. Audit and other post-commit effects remain outside that transaction.

Migration rollback disables owned providers and removes encrypted client
configuration/pending proofs while retaining existing users, sessions and
identity bindings. It is destructive to OIDC configuration and is not an approved
production recovery action.

## Local verification

From the repository root:

```sh
node scripts/test-wikisavvy-oidc.mjs
```

The runner creates only its own pinned, disposable loopback PostgreSQL fixture and
redacts its generated credentials. Tests include real SDK signature verification,
database concurrency/rollback and HTTP guard/cookie/redirect cases. Provider
network responses are controlled fixtures, not a live Authentik instance.

Frontend tests cover the independent login/account/provider controls. These checks
do not prove live-provider configuration, complete browser navigation, production
rate limiting, deployment readiness or the broader SSO/MFA feature program.
The license and capability registry remain unchanged.

After building the server, `node scripts/test-wikisavvy-oidc-native.mjs` verifies
the compiled adapter with the native installed SDK outside Jest's module
transforms. It uses controlled responses, accepts a real fixture signature and
rejects a tampered one. It does not make network requests or build the server
itself; rebuild before using it to verify changed source.
