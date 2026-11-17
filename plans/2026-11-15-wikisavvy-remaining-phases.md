# WikiSavvy — UI cleanup and remaining phases

Requested sequence: remove upstream product branding from ordinary UI, then
continue the independent Enterprise implementation program.

This is the overall work queue, not a claim that every feature has a complete
design. Phase 1 licensing is deployed. Later phases require focused implementation
plans and acceptance evidence before enabling their capabilities.

## Boundaries

- Preserve the existing uncommitted branding/licensing changes.
- Use WikiSavvy for ordinary product text. Preserve required copyright/license
  notices; do not erase attribution or claim upstream code was independently
  authored.
- Do not rename internal package names, database objects, storage keys, callback
  routes, user content, provider resource identifiers or test fixture URLs just
  to remove a visible brand name.
- Do not invent support addresses, documentation sites or customer portals.
  Remove irrelevant upstream sales/support links instead.
- Keep inactive upstream EE implementations separate. Independently implement
  replacement backends and screens, using the reusable AGPL core where suitable.
  Do not enable features by returning true from the legacy entitlement checker.
- Register a capability as implemented only after its backend, UI and acceptance
  tests pass. Licensing never substitutes for authorization.
- Expiry/removal must not disable existing access restrictions, MFA/SSO enforcement
  or access to existing content. No automatic user removal or destructive purge.
- This request authorizes local implementation work, not unspecified future
  production deployments, identity-provider changes, real signing-key setup,
  commits or pushes. Obtain exact operational approval when those actions arise.

## A. Ordinary UI branding

### Targets

- `apps/client/src/pages/settings/license-edition.tsx` and its tests: remove the
  upstream backend explanation from product copy; keep accurate Community/license
  status and applicable legal notices.
- `apps/client/src/features/public-space/components/docs/docs-footer-branding.tsx`
  and `pages/public-space/public-space-directory-page.tsx`: use WikiSavvy wording
  without linking to an unrelated upstream product site.
- `apps/client/src/components/settings/settings-sidebar.tsx`: remove the upstream
  support email rather than inventing a replacement.
- `apps/client/src/features/home/components/home-ai-prompt.tsx`: remove the
  hardcoded upstream fallback.
- `apps/client/src/features/integration/pages/connections.tsx` and
  `integrations.tsx`: replace ordinary product wording and review upstream
  documentation links without changing connection identifiers or callback behavior.
- `apps/client/public/locales/*/translation.json`: keep translated visible copy
  consistent and preserve interpolation variables.
- Extend branding/component tests with visible text/link assertions. Exclude legal
  notices, internal symbols and genuine external-content fixtures from branding
  assertions. Inactive EE screens will be replaced with independent screens as
  their phases are implemented, not relabeled as implemented features.

The subsequent route review found reachable AI, announcements and API-key upsell
screens. The user explicitly selected independent status views for these routes.
`App.tsx` now routes their eight URL variants to the independently owned
`features/capabilities/components/feature-unavailable.tsx` until their replacement
features ship. Security and MFA routes are excluded and covered by regressions.

### Verification

Run affected component/branding tests before and after changes, full frontend tests
and build, translation JSON/interpolation checks, and a separate rendered-text/link
self-review. Do not claim a source-text replacement proves every rendered route.

## B. Phase 2 — authorization, security controls and audit foundations

Start by tracing existing enforcement and writing a focused threat model.

Relevant existing files include:

- `apps/server/src/core/page/page-access/page-access.service.ts` and tests:
  existing view/edit/comment/export checks must not regress.
- `apps/server/src/database/repos/page/page-permission.repo.ts`: reuse core
  persistence and inheritance semantics only after tracing them.
- `apps/server/src/integrations/audit/audit.service.ts` and
  `common/events/audit-events.ts`: existing interfaces/events currently feed the
  no-op provider in this build.
- `apps/server/src/core/licensing/` and `packages/wikisavvy-license/src/index.ts`:
  independently owned capability checks, without bypassing legacy EE licensing.
- New independently owned permission/security/audit management services, routes,
  UI and tests; choose their exact paths in the focused Phase 2 plan.

Acceptance must cover cross-workspace denial, role and group access, inheritance,
revocation, concurrent updates, stale caches/sessions, search/export/attachment/
collaboration enforcement, sanitized audit payloads and expiry preserving security.
Clarify management roles and audit failure behavior before changing authorization.

The first audit-foundation slice is implemented and verified, including real
PostgreSQL persistence and authenticated application HTTP checks. It was deployed
with explicit production approval on 2026-11-16 at 17:10 UTC, but does not complete
this phase. The focused scope and evidence are in
`2026-11-16-wikisavvy-phase2-audit-foundation.md` and
`2026-11-16-wikisavvy-phase2-audit-verification.md`. Basic owner history is available
independently of licensing; advanced audit controls, SIEM and retention remain
unfinished. Page-permission management subsequently shipped on 2026-11-17;
this does not complete the remaining security controls.
Production rollout and recovery evidence is in
`2026-11-16-wikisavvy-audit-deployment.md`.
Do not add blanket admin bypasses or log credentials/request bodies.

## C. Phase 3 — identity and provisioning

On 2026-11-17 the user prioritized security and SSO before content, structured
data, AI or other feature phases, choosing the existing `auth.codesavvy.io`
Authentik instance and independent OIDC first. Start with session/login,
revocation, recovery and access-boundary security checks. Review explicit account
linking, emergency login and provider-failure behavior before SSO implementation
or enforcement. Do not silently provision accounts or link by email alone.
The scoped local/license/version plan is
`2026-11-17-wikisavvy-license-version-security.md`. No production identity-provider
write or SSO enforcement is authorized by this priority decision.

Independently implement the agreed SSO providers, MFA, provisioning, API keys and
OAuth. Specify account linking, recovery, break-glass behavior, deprovisioning and
token scopes before coding. Test provider errors, replay, expiry, revocation,
cross-workspace boundaries and lockout prevention. Production identity-provider
configuration is a separate operational change.

## D. Phase 4 — content and operational workflows

Implement templates, comments/workflow controls, personal spaces, announcements,
page verification, import/export and advanced integrations in independently
testable slices. Specify import compatibility, file limits and provider behavior.
Audit/SIEM and retention build on Phase 2's event model; destructive retention
execution is not implicitly authorized by implementing its configuration UI.
Preserve existing Community integrations and data access.

## E. Phase 5 — structured data

Implement Bases, table/Kanban views, typed properties, formulas and real-time
updates. Specify formula compatibility, access control, concurrency and migration
behavior. Test permissions, invalid formulas, round trips and simultaneous edits.

## F. Phase 6 — search, indexing, AI and MCP

Implement permission-filtered search/indexing, attachment extraction, AI and MCP
only after the authorization and identity foundations pass acceptance. Specify
provider settings, data disclosure boundaries and cost-bearing operations.
Test content/attachment access filtering, prompt/tool injection boundaries,
untrusted files, token scopes, cancellation and failures. No training, indexing
backfill or external provider writes without exact operational approval.

## G. Phase 7 — parity and release hardening

Verify the capability inventory against actual shipped behavior. Cover end-to-end
security, accessibility, performance, migration/restore, upgrade/rollback and
operator documentation. Report partial parity and external-service limitations
honestly. Review each production release and obtain exact approval before cutover.

## Working method and known baseline

Proceed one verifiable slice at a time: tests first, minimal implementation,
broader checks, separate self-review, then update the capability inventory.
Do not mark a phase complete because its UI exists.

Phase 1's last verified frontend baseline is 98 files / 1,282 passing tests.
The backend has 16 reproduced pre-existing failing suites; new work must distinguish
those from regressions. The existing lint configuration has a missing TanStack
plugin entry. Use pinned pnpm 12.16.1 and the already established local launcher;
do not modify global package-manager configuration.
