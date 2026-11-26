# WikiSavvy independent page templates

## Goal

Let workspace members create reusable page templates and start a new page from one,
using independently implemented backend and screens placed where the existing
Templates controls already are. Not a switch flip: the legacy EE checker is not
used and `Feature.TEMPLATES` is not granted.

## Current state (verified 2026-11-24, commit 21e78f20)

- Database: `templates` table exists from migration `20260412T135891-templates.ts`
  and is typed in `db.d.ts`. No schema change is assumed yet; it must be re-read
  before implementation.
- Backend: no template controller or service under `apps/server/src/core` (the only
  hits are workspace settings). The legacy EE endpoints the client calls
  (`/templates`, `/templates/create|info|update|delete|use`) have no live server
  route in the core code.
- Persistence already exists in `database/repos/template/template.repo.ts`,
  registered by `DatabaseModule`; evaluate and reuse this core repository rather
  than duplicating it. Listing/find operations need review of soft-deleted rows
  and the approved workspace-only scope before integration.
- Client: legacy screens under `apps/client/src/ee/template` are gated by
  `Feature.TEMPLATES` and show "Available with a paid license" otherwise.
- Audit events `template.created` and `template.deleted` exist in
  `common/events/audit-events.ts`.

## Scope (in)

1. Backend module `core/template`: create, list, read, update, delete, and
   "use" (create a page from a template in a space the user can edit).
2. Permissions: any workspace member may read templates. Members may publish
   workspace-readable source pages; restricted sources require explicit
   workspace-admin confirmation and the admin must still have source read access.
   Edit/delete only by the author or a workspace admin. Using a template requires
   edit access to the target space and, where applicable, the target parent page.
3. Audit: `template.created` and `template.deleted` on success only, with safe
   metadata (no page body).
4. Client: independently implement the template library, editor and picker under
   `apps/client/src/features/template/`, placing them at the existing routes and
   entry points. Do not activate the upstream EE screens or entitlement checker.

## Scope (out)

- Space-scoped template libraries, sharing across workspaces, versioning, import
  or export of templates, AI generation, and changes to upstream EE screens.
- Any change to licensing, capability registration or the legacy entitlement checker.
- Schema changes beyond what the existing `templates` table needs; if one is
  needed it is a separate reviewed migration.

## Confirmed decisions (2026-11-25)

1. All workspace members may create templates.
2. Store a snapshot, not a live link to the source page.
3. Templates remain after the source page is deleted.
4. Members may publish only workspace-readable sources. Restricted sources
   require explicit admin confirmation, without bypassing source read access.

## Follow-up findings before implementation (2026-11-25)

- The existing schema has no source-page foreign key, so source deletion need
  not delete the template. `space_id` does cascade on space deletion; workspace
  templates must not depend on a source space for their lifetime.
- Page attachments are owned by pages and cleaned up on page deletion
  (`core/attachment/services/attachment.service.ts`). Copying JSON alone does not
  provide a durable snapshot of embedded files. Attachment ownership, copying,
  authorization and cleanup require a focused design and tests.
- Workspace-wide template publication can disclose content from restricted pages.
  Source read access alone is not sufficient evidence of permission to publish
  that content to everyone. The confirmed rule above applies to direct and
  inherited restrictions, private/personal spaces, and open spaces lacking
  read membership for any active workspace member.
- Existing `allowMemberTemplates` UI and workspace updates are legacy-gated.
  The independent implementation must reconcile this control with the approved
  all-member policy without bypassing unrelated security settings.
- The earlier suggestion to repoint EE screens contradicted the independent
  implementation boundary in the overall roadmap; independent replacements
  at the same original UI locations are required instead.

## Steps (each with a failing test first)

1. Read the existing `templates` table definition and its foreign keys.
2. Service and repo tests for create/list/read/update/delete/use, including
   cross-workspace rejection and permission denial for non-authors.
3. Implement the service and controller to make them pass; register in `core.module.ts`.
4. Audit tests: success logged, failure not logged, metadata has no body.
5. Client tests: picker shows templates for members; no paid gate; create and use
   flows; error and empty states.
6. Full client suite, client type-check, the dedicated test runners for any
   touched areas, and a separate self-review.

## Verification

- Exact command outputs recorded before any commit.
- Deployment is a separate approval: staged image, fresh backup and restore check,
  image-only cutover, rollback to the current `21e78f20` image.

## Risks

- The legacy client code expects response shapes that may differ; the new
  endpoints must match the screens or the screens change.
- A "use template" action copies content, so it must respect the target page's
  permissions, not only the space's.

## Implementation checkpoint (2026-11-25)

- Added `core/template/template-publication-policy.ts`, not registered or exposed
  as an API yet. One SQL query reads current actor role, source content, live
  direct/group read membership, ancestor restrictions and workspace audience.
  Returns a content snapshot only after authorization; elevated role never
  bypasses source read access. No entitlement checker was changed.
- Added 27 isolated PostgreSQL integration cases and
  `scripts/test-wikisavvy-templates.mjs`. Initial test run failed because the policy
  did not exist; after implementation 25 cases passed and two exposed a
  double-encoded JSON fixture, corrected without changing the policy.
  All 27 cases now pass.
- Existing `PageAccessService` tests: 5/5 passed before changes. Changed-file
  backend ESLint passed. Server `tsc --noEmit --pretty false` still reports the
  known baseline `persistence.extension.spec.ts(44,17)` constructor-arity error;
  this is not a clean full type-check.
- Final rerun: 27/27 publication tests and 5/5 page-access baseline tests passed;
  changed-file ESLint, Prettier check, runner `node --check` and `git diff --check`
  passed. Full backend/frontend suites, builds, pre-commit hook, migrations,
  runtime API and rendered UI acceptance were not run for this isolated slice.
  An initial baseline rerun from the root missed the server Jest configuration;
  rerunning from `apps/server` passed without code changes.
- Separate self-review covered the new policy, full integration tests and runner:
  no blocker found in this unregistered slice. Full application integration,
  concurrency and embedded-content/file authorization remain required.
- Pinned pnpm executable fails with `ENOEXEC`; used installed Node/Jest,
  TypeScript, Prettier and ESLint entry points without changing configuration.
- This is the publication-policy slice only: no template persistence, CRUD
  endpoints, UI, actual file snapshot durability or deployed behavior is claimed.
  Source snapshot validation must be integrated atomically with persistence;
  using the same transaction alone is not a proof against revocation races.

## Approved storage extension (2026-11-25)

The user approved this extension and requested commit, push and deployment.
No production change is authorized without the exact release target and a fresh
explicit `prd` window. The implementation remains local at this checkpoint.

1. Add nullable `attachments.template_id` with an indexed foreign key to
   `templates.id`, plus the generated database type. Template files must have no
   source `page_id` or source `space_id` lifetime dependency.
2. Independently copy source-owned embedded files to template-owned storage and
   rewrite snapshot attachment references. Authorize every referenced file;
   never copy unreadable cross-page or cross-workspace content merely because
   the source JSON contains its ID.
3. Expose template files only through authenticated workspace/template checks,
   not public logo/avatar handlers or existing page-scoped signed tokens.
4. On use, copy template-owned files to target-page ownership and enforce target
   space creation and parent-page edit permissions before creating anything.
5. Coordinate storage cleanup, database rollback and retries without cascading
   away file rows before their storage objects have been safely handled.
   Existing source files are never deleted by template operations.
6. Test source-page/source-space deletion preserving template bytes, target
   ownership, tenant denial, missing files, failed copies, cleanup retries,
   restricted embedded references and concurrent permission changes.

Do not publish the enabled entry points to production until the storage contract
and the complete backend/UI pass acceptance.

## Release preparation checkpoint (2026-11-26)

The initial policy-only checkpoint above is historical. The implementation now
includes the complete independent module and UI at the original entry points:

- `core/template/`: CRUD, use in a new page, current-page attachment preparation,
  private template-file downloads, source-publication policy and storage lifecycle.
  All routes require a persisted interactive session and matching workspace.
- All members may create blank templates or source snapshots; authors and
  workspace admins may manage them. Source publication is checked before and
  after file copying using live roles/membership and inherited restrictions.
- Strict document validation uses the core ProseMirror schema. Synced references
  must be resolved and external/pending media uploaded before snapshot creation;
  unsupported content is refused with an actionable error, never silently kept
  as a live source/file reference.
- Migration `20261125T180000-wikisavvy-template-files` adds indexed nullable file
  ownership and an exclusive-owner CHECK, plus a durable copy-cleanup journal.
  Reservations commit before storage writes; per-operation transaction locks
  exclude active copies from cleanup. Missing copy destinations abort publication.
  Template deletion is soft, and physical cleanup is retryable. Reversal refuses
  to remove ownership while template files or cleanup reservations still exist.
- Independent `features/template/` screens replace the original library/editor,
  global/space sidebar controls and empty-page picker. No legacy EE entitlement
  was enabled. The original member-template setting location truthfully displays
  the confirmed fixed all-member policy rather than an ineffective legacy switch.
- The empty-page flow prepares current-page-owned file copies before inserting
  content into the live editor; a nonempty editor is never intentionally replaced.
  New-page use creates a fresh Yjs document through the core page service.
- Editors send the prior update timestamp, retain drafts on save failure, freeze
  edits while saving, and load server-remapped file references after success.
  Destructive template deletion requires a UI confirmation. Destination errors
  appear inside the picker dialog.

Verified before the release-image build:

- `node scripts/test-wikisavvy-templates.mjs`: 79 tests passed, including real
  PostgreSQL, real local-storage copies, failure/restart cleanup and controller
  boundaries. Lifecycle tests mock the core page engine; exact-image acceptance
  below is still required to verify that integration.
- `node scripts/test-wikisavvy-oidc.mjs`: 110 passed.
- `node scripts/test-wikisavvy-page-permissions.mjs`: 68 passed.
- Final full client suite: 112 files / 1,407 tests passed, including the
  dialog-error regression. Focused Templates client suite: 18 passed.
- Client type-check passed. Production server `tsconfig.build.json` type-check
  passed. Full server type-check retains only the known test-constructor error
  in `persistence.extension.spec.ts(44,17)`.
- Changed-file backend lint passed. Client lint remains blocked by the existing
  missing `@tanstack/eslint-plugin-query/build/modern/index.js` package entry.
  Client tests run with the installed `/opt/homebrew/bin/node` (26.10.0), because
  the active Node 24 rejects the repo's configured `--no-webstorage` flag.
- Self-review found and corrected NULL semantics in the ownership CHECK, the
  core local driver's silent missing-source copy behavior, stale editor file
  references and dialog error visibility. Corresponding regressions passed.

Remaining release gates:

1. Final formatting, focused/full regressions and staged-diff/secret-path review.
2. Commit, then build the complete amd64 release image from that clean revision.
3. `scripts/test-wikisavvy-templates-runtime.mjs --image <sha256>` against isolated
   PostgreSQL/Redis and real sessions/files, without a server bind mount. This
   verifies native core page creation, document validation, all source migrations,
   source-page/source-space deletion, file independence, tenant/session denial and
   audit sanitization.
4. Build/runtime and rollback-image compatibility checks before pushing the release.
5. Obtain explicit approval of the exact `prd` target/window, then fresh backup,
   isolated restore/off-host verification and the reviewed cutover procedure.
   Apply only this additive migration; use the schema-aware recovery image
   described below without reversing/removing stored template data.
   No Caddy, Authentik, DNS, license or environment changes are included.

## Verified release and recovery artifacts (2026-11-26)

Status: code pushed and artifacts locally verified; **not deployed**.

- Release source: `c49a7effb3b8b552d2d224b9daad47c1f4753171`, pushed to
  `AI-Savvy-NL/docmost` `main` and read-back verified.
- Complete amd64 image: `wikisavvy:2026.11.26-c49a7eff`,
  `sha256:1f750966176ead41e48cba9f97a5da2fd6aa9aa893a8683c1bb8cb5fe2ca0a48`.
- Exact-image native acceptance: **55 checks passed**, all **66 migrations**,
  real persisted sessions, PostgreSQL, Redis, core page/Yjs creation and physical
  file storage, without a compiled-server bind mount. Source page and source space
  deletion preserve templates; deleting templates preserves target-page files.
- Recovery source: `7bd575569ab5b57fbf2cf79d33d5883e0d9237cc`. This detached local
  recovery worktree differs from the previous application commit `21e78f20` in
  exactly one file: the byte-identical forward migration from the release.
- Recovery image: `wikisavvy:2026.11.26-7bd57556`,
  `sha256:03683837dcd6a417a86b322bc505662cadbc24ba2d59cc1651c0b284155ced15`.
- `scripts/test-wikisavvy-templates-recovery.mjs`: **23 checks passed**. The
  untouched old image is explicitly shown to refuse startup against the upgraded
  database because Kysely rejects an applied migration missing from its provider.
  The schema-aware previous-code image starts healthy and retains exact template,
  attachment, page-content and migration fingerprints. Returning to the release
  restores template access and identical physical file bytes.
- The first recovery fixture attempt failed with `templates/create` 403: its
  owner had not explicitly confirmed restricted-source publication. Correcting
  the fixture request, not the application policy, made the rehearsal pass.
- The former claim that the untouched `21e78f20` image could provide image-only
  recovery after this migration is invalid. Do not use it for that rollback, do
  not edit migration history, and do not reverse the ownership migration while
  template files exist.

The recovery source/worktree and build context remain local; the recovery image
has not been staged remotely. Private build/runtime/recovery logs are under the
session's `wikisavvy-templates-20261126` evidence directory. The follow-up test and
documentation changes do not modify the application source in `c49a7eff`.

Remaining before production: explicit approval for this release, the single
additive migration and the schema-aware recovery target within a fresh UTC
window; read-only drift/preflight checks; consistent backup, isolated restore and
off-host verification; staging and artifact-equivalence checks; guarded cutover;
local/proxy/HTTPS verification. Manual rendered-browser and multi-client editing
acceptance have not been performed by these test runners.
