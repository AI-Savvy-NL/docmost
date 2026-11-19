# Authentik gateway, native SSO and original settings placement

## Requested outcome

The user wants independently implemented enterprise features in their original
settings locations, not duplicate fork-specific navigation. They separately
selected **Proxy gate + native SSO** for `wiki.codesavvy.io`, after being told
that an Authentik outage would also block public password login.

After the read-only preflight and this concrete plan, the user explicitly selected
**Approve prd setup + UI**. The approved window is **2026-11-19 06:14:12–08:14:12
UTC**. It covers the local changes/tests, commit/push, exact tested release,
specified Authentik/vault/application changes, conditional wiki gate publication
and drift-guarded recovery below. The exact private resource identifiers and
approval are recorded in the operator's private setup directory.

The gate must not be published before the user's real native linking and SSO
acceptance. This approval does not allow impersonation, unrelated changes or
continuing after its UTC window expires.

## Verified preflight

- The current WikiSavvy application is healthy on `2026.11.18-350a8ca6`, with no
  configured OIDC provider or linked identity.
- The proposed native/gateway application slugs and wiki proxy host have no
  matching existing Authentik resources in the scoped reads.
- The existing owner Authentik identity was resolved. The existing RSA signing
  key, OpenID scope mapping and authentication/authorization/invalidation flows
  are available; no global identity flow needs modification.
- The embedded proxy outpost is healthy and uses the canonical Authentik HTTPS
  host. Its nine existing provider assignments must be preserved.
- Caddy's wiki route matches the running configuration and currently has no
  Authentik gate. Existing setup/public-sharing denials must remain intact.
  Wiki access logging is not enabled; do not introduce proof-bearing access logs.
- From the actual application container, Authentik resolves to the private HTTPS
  proxy. HTTPS certificate/hostname verification succeeds, but the outbound guard
  refuses that private address under the current empty network allowlist.
- Both OIDC origin trust and an exact proxy `/32` plus TCP443 outbound allowance
  are needed. The network allowance is shared by the application's outbound
  guard, not a new SSO-only policy. Never use `all`, a LAN subnet or disabled TLS.

Preflight details are sanitized and retained privately. No Authentik, Caddy,
application configuration or user-content changes occurred.

## A. Put existing independent controls in the original UI

Concrete targets:

- `apps/client/src/components/settings/settings-sidebar.tsx`: make the existing
  **Security & SSO** entry reach the independently implemented owner controls.
  Do not grant a blanket upstream Enterprise entitlement.
- `apps/client/src/ee/security/pages/security.tsx`: place independent workspace
  OIDC management in the existing SSO section at `/settings/security`. Preserve
  existing security controls and their actual feature/role boundaries.
- `apps/client/src/features/oidc/oidc-account.tsx` and a focused workspace settings
  component beside it: move provider creation/editing/rotation out of Profile.
  Keep personal account linking/status in Profile; it is an account action.
- `apps/client/src/features/oidc/oidc-provider-form.tsx`: reuse the current secure
  form, password confirmation and sensitive-input clearing.
- Existing OIDC UI and feature-route tests, plus sidebar/owner-access tests:
  verify placement, keyboard/focus/loading/error states, owner-only management,
  member/admin denial and unchanged legacy entitlement boundaries.
- `docs/wikisavvy-oidc-pilot.md`: update navigation and describe the configured
  proxy gate separately from native account linking.

Already implemented capabilities belong in their original locations. Unimplemented
features such as independent SCIM or verified pages are not enabled merely by
removing a lock or changing a license flag. No new feature-parity claim, license
capability or upstream EE unlock is included.

Run focused red/green UI tests, client type-check, the full frontend suite,
affected backend/security tests, build and separate self-review. Source
publication and deployment require approval of this concrete scope; publish only
the reviewed changes. Build and verify the exact resulting committed image.

## B. Configure native Authentik SSO first

Proposed new resources:

1. Authentik application `wikisavvy`, with a confidential OAuth2/OIDC provider.
   Use authorization-code flow, RS256, stable user-UUID subjects, per-provider
   issuer and only the OpenID mapping required by the current pilot. Register
   the exact strict callback:
   `https://wiki.codesavvy.io/api/oidc/callback`.
2. Bind access directly to the verified owner Authentik account only. Do not
   grant access to all Authentik users, a broad group or an unrelated service
   identity. Preserve every existing application, binding and signing key.
3. Generate the client secret privately. Store its operator copy in a new
   Agent-vault item named **WikiSavvy Authentik OIDC**. Pass it to Authentik and
   WikiSavvy privately, never chat, logs, command arguments or a plaintext file.
4. Add only `https://auth.codesavvy.io` to WikiSavvy's OIDC origin allowlist and
   the exact verified private HTTPS proxy `/32:443` to its outbound policy.
   Preserve all other compose/environment values, mounts, trust and license.
5. Through a real workspace-owner session and password reauthentication, save the
   native provider through the owned configuration API. Read issuer/client details
   back from the created provider and discovery; do not guess the actual issuer.
   The WikiSavvy database stores the client secret purpose-encrypted.

Before changes, take a fresh private application/configuration backup, verify its
restore and off-host hashes, and capture drift guards for the affected resources.
Deploy only the reviewed UI release and two approved configuration values; do not
recreate database/Redis, change schemas, DNS, firewall, license or trust.

### Interactive acceptance boundary

The user must complete the real Authentik browser authentication/MFA and explicit
account-linking flow, then a native SSO sign-in. A matching email, admin API token,
impersonation or a direct identity-table insert is not an acceptable substitute.

Verify live discovery/JWKS/signature compatibility, exact binding, persisted
session issuance, redirects, wrong-password rejection and normal password login.
Never claim live SSO success from metadata reads or mock-issuer tests.

## C. Publish the proxy gate only after native SSO works

1. Create a separate hidden Authentik gateway application `wikisavvy-gateway`
   with a single-application forward-auth proxy provider for
   `https://wiki.codesavvy.io`. Bind it to the same verified owner only.
   No Basic-auth forwarding, header-auth bypass or skip-path regex.
2. Add only this new proxy provider to the existing embedded outpost's current
   provider set after a drift check. Preserve all nine existing assignments and
   all existing outpost configuration.
3. Adapt/compare the Caddy candidate and update only the canonical wiki host.
   Forward the required `/outpost.goauthentik.io/*` protocol paths to the existing
   verified outpost; apply its authentication check before the real wiki proxy.
   Keep the existing setup/public-sharing restrictions and canonical redirects.
   Do not trust proxy identity headers as a WikiSavvy account or session.
4. Gate the wiki UI, APIs, assets and WebSocket handshake. No blanket `/api`,
   native callback or public-health bypass. Preserve the original authenticated
   request, app cookies and legitimate API Authorization header. Strip untrusted
   identity headers; do not introduce credential/proof logging.
5. Validate before graceful reload. Re-read configuration/PID/routes, verify
   other routes unchanged, and verify proxy-to-wiki/outpost health.

The approved scope must explicitly cover this Caddy change and the exact outpost
assignment. If interactive acceptance or approval expires, stop before gate
publication instead of making the wiki inaccessible.

## Verification and recovery

- Verify native owner linking and SSO login before publishing the gate.
- Verify allowed-owner and non-owner authorization, unauthenticated gate
  redirects, no spoofed-header/API bypass, safe callback behavior, secure cookies,
  assets, private content, search, attachments and authenticated WebSocket
  upgrade/ping-pong after publication.
- A proxy login is not itself a WikiSavvy login. Ordinary WikiSavvy sessions and
  server authorization remain required. No automatic signup/email linking.
- Public unauthenticated health checks and direct programmatic clients will be
  gated too. Report that behavior rather than adding an undocumented exception.
- Existing Authentik login/MFA policy is reused, not weakened. WikiSavvy logout
  is not global IdP logout; session deprovisioning/SLO is not newly implemented.
- On gate failure, restore only the reviewed wiki Caddy change after drift
  checks. On app/config failure, return to the verified previous image and
  previous values of the two configuration entries; preserve data and license.
  Disable the new WikiSavvy provider if necessary and remove only the new
  outpost assignment after a drift check. Retain new Authentik/vault objects for
  investigation rather than silently deleting identities or shared resources.
- No rollback may overwrite concurrent changes, disable TLS, downgrade schema,
  remove existing bindings/providers or delete user sessions/content.

The prior production rollout's known full-backend/type/lint baseline limitations
remain separate from new regressions. Final reporting must distinguish prepared,
configured, linked, SSO-verified and proxy-published states with real evidence and
timestamps.

## Local UI verification — 2026-11-19

Provider management now uses the original Security & SSO page; Profile retains
personal linking only. Owner navigation does not grant a legacy entitlement.
Existing entitled provider-list/prefetch behavior and export-disable recovery
navigation remain covered. Unentitled SSO/SCIM queries are not started merely
because the owner can open the independent settings.

- 109 frontend files / **1379 tests passed**, including new role, original-route,
  profile/workspace separation and enabled/disabled query compatibility cases.
- Client TypeScript passed; all **5 workspace build tasks succeeded** (4 cached).
- Dedicated OIDC **100 tests**, recovery PostgreSQL/HTTP **64 tests**, and native
  compiled SDK valid/tampered-signature smoke passed.
- Separate correctness/security/coverage self-review found no remaining scoped
  blocker. No backend permission, license or capability implementation changed.
- Existing frontend lint packaging and broad backend baseline limitations were
  not repaired or hidden. No repository pre-commit hook is installed.

At this verification checkpoint, no Authentik objects, vault item, production
environment or Caddy gate have been changed. Deployment and live interactive
acceptance remain separate phases; these local checks do not prove live SSO.
