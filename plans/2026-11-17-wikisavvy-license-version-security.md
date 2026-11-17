# Personal license, visible releases, security priority

The user approved these choices on 2026-11-17:

- Personal WikiSavvy license for Ramsy de Vos, unlimited seats, one year.
- Settings release identity generated from UTC build date and committed source
  revision, with the upstream base version separate.
- Security hardening followed by independently implemented Authentik OIDC.

## Local implementation

1. Extend `integrations/security/version.service.ts` and its tests to return a
   validated fork release identity while preserving the base version. Upstream
   release lookup failure must not hide the running version.
2. Extend the client `IVersion`, Settings `app-version.tsx` and interaction tests.
   Never present an unbuilt working-tree edit as a deployed release.
3. Add tested release-build automation using clean committed source, immutable
   revision/date image metadata and the same values in the application. Update
   Docker and GitHub release build paths.
4. Correct the issuer README's obsolete empty-capability statements. Prepare the
   personal workspace-bound license privately; keep the issuer private key off the
   repository, image and server. Never display keys or license envelopes.
5. Run focused tests, client type-check, scoped lint and a workspace build; perform
   a separate self-review. Existing baseline failures remain separate.

## Operational boundaries

Issuance does not install production trust or activate a license. Those actions
need a scoped approval naming VM108 / wiki.codesavvy.io, public trust mount and
environment change, application restart, activation, verification and recovery.
No production version rollout, commit or push is included in the local approval.
The new license initially grants only `wikisavvy.page-permissions`; unimplemented
capabilities and separately licensed upstream EE remain unavailable.

## Next priority: security and SSO

Before other feature phases, audit session/login boundaries, revocation, account
recovery, rate limiting and permission isolation. Independently implement OIDC for
`auth.codesavvy.io` only after a focused threat model and reviewed linking/recovery
policy. Require verified issuer/audience/signatures, state, nonce, PKCE, replay
protection, exact redirects, explicit account linking and a tested emergency-login
path. No silent email-based linking or automatic provisioning by default.

Specify deactivation/session revocation, provider failure and SSO enforcement
before enabling enforcement. Expiry must not disable existing security controls.
Changes to Authentik clients/providers and production authentication require their
own exact approval. This is a priority decision, not an SSO completion claim.

## Results — 2026-11-17

- The user separately approved production public trust, application-only restart,
  personal license activation and recovery for **19:36:17–21:06:17 UTC**.
  Configuration verification passed at **19:46:05 UTC**, owner HTTPS activation
  at **19:47:48 UTC**, and database/application verification at **19:48:38 UTC**.
- The personal license is active, unlimited, and expires
  **2027-11-17T19:34:51.213Z**. Only `wikisavvy.page-permissions` is granted.
  Existing live-page permission state was unchanged except that eligibility to
  create a new restriction became true. No restriction was created by verification.
- Only public issuer trust was mounted read-only. The private issuer key and
  license envelope remain outside the repository and server. Production image
  `7b93b5ba`, database/Redis containers, 63 migrations, core data and storage were
  preserved. One encrypted license and one activation event were verified.
- SSH-agent refusal initially prevented execution; after the user confirmed the
  same key was unlocked, the approved operation succeeded without changing roles.
  An operator helper initially assumed login had a `data` field. A read confirmed
  no license existed before correcting that response handling and activating once.
- Version UI/API: **9 backend tests and 6 frontend tests passed**. Release-build
  automation: **7 tests passed**, including dirty-tree refusal and exact-revision
  archive/build behavior with mocked external commands.
- Issuer CLI: **3 passed**; signature/license policy: **13 passed**; licensing and
  trust services: **11 passed**. Client type-check and scoped backend lint passed;
  all **5 workspace build tasks succeeded** (3 cached).
- The inherited CI workflow still targets upstream publishing destinations.
  Publication was not dispatched or reconfigured. Local release automation does
  not publish; this remains a release-safety item for the prioritized security work.

Version changes remain **local, uncommitted, unpushed and undeployed**. The exact
new release-image build and production version-display verification remain pending
commit/release approval. The build helper deliberately refuses the dirty working
tree rather than labeling its contents as committed source. Full backend tests
and frontend lint were not repeated; their previously documented baseline issues
remain separate. Browser rendering and multi-client editing were not tested.

Security/SSO is prioritized and planned, **not implemented or enforced** here.
Sanitized activation evidence is retained in the operator's private Docmost
licensing directory; no keys or envelopes are embedded in this plan.
