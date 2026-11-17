# Release-smoke readiness — local fix

Approved local scope: correct the startup fixture budget, add safe diagnostics
and an immutable complete-image test entrypoint. No application authorization,
request deadline, assertion, commit/push or production change is authorized here.
The previous production window has expired.

## Evidence

- The unchanged candidate passed 13 instrumented normal runs. The ten-run batch
  measured startup at 3.588–4.144 seconds and setup at 319–333 milliseconds.
- With only the disposable local application container limited to 0.15 CPU,
  the old fixture failed readiness at approximately 46 seconds. The same running
  container subsequently returned health 200 at 81.192 seconds, including an
  internal health check; no error/OOM/crash marker was detected.
- At 0.3 CPU the original 28 assertions passed, with startup 23.831 seconds and
  setup 1.309 seconds.
- This proves a startup-budget false-negative under resource constraints. It
  does not retrospectively identify the historical setup/login failure.

## Steps

1. Add `scripts/wikisavvy-runtime-fixture.test.mjs` first, with deterministic
   clock-driven deadline, boundary/error, image-option and redaction tests.
2. Add `scripts/wikisavvy-runtime-fixture.mjs`: monotonic bounded readiness,
   120-second application startup only, unchanged 45-second default waits and
   five-second HTTP request limits, immutable local image selection and safe
   error classification.
3. Update `scripts/test-wikisavvy-audit-runtime.mjs` to use these helpers.
   `--image sha256:…` tests the complete local image without a server bind mount;
   the default compiled-server mode remains available. Do not retry setup/login
   or any other mutation.
4. Run helper regression tests and syntax checks; run ten complete-image repeats,
   baseline comparison and the controlled 0.15-CPU reproduction using the new
   startup budget. Preserve all failures and investigate any discrepancy.
5. Separately self-review safety, retained assertions, actual request limits,
   cleanup, provenance and remaining unknowns. Record exact evidence here.

Acceptance requires the unchanged security/session/audit assertions to pass.
A startup-budget correction is not an application fix, a guarantee against all
future flakes, or permission to deploy. Unexpected request failures must remain
failures and report only sanitized classifications, not bodies, cookies or logs.

## Implementation and verification

The helper and harness changes are implemented locally. Only the application
health/readiness gate selects the 120-second budget. Ordinary waits remain
45 seconds, health probes retain their two-second request limit, and all other
HTTP requests retain their five-second limit. The 22 original `check(...)`
statements (28 assertions after loop expansion) are unchanged.

The monotonic polling deadline also has an independent timer: a stuck probe
cannot extend the wait indefinitely. Pending polling delays and deadline timers
are cancelled on completion. No setup/login or other mutation retry was added.

Verified so far:

- Missing-helper regression failed first; the initial 14 helper tests then passed.
- An additional never-settling-probe regression failed at the test runner's
  one-second limit, then passed after adding the independent deadline timer.
- All 15 helper regressions pass; all 18 checked-in Node script tests pass.
- Script syntax and `git diff --check` pass.
- Missing local image fails before fixture creation with a sanitized
  `AssertionError` classification.
- One direct complete-image run passed all 28 assertions with no bind mount and
  startup measured at 5.704 seconds.
- All 15 helper regressions also pass under the release image's Node 26 runtime.
- The prior compiled-server bind-mount mode passed all 28 assertions.

Complete-image acceptance finished **2026-11-17 at 06:33:57 UTC**:

| Case | Result | Application startup |
| --- | --- | --- |
| Deployed-baseline image | 28 assertions passed | 5.674 seconds |
| Candidate image, ten sequential runs | 10/10 passed, 28 assertions each | 3.629–4.681 seconds |
| Candidate, same local 0.15-CPU constraint | 28 assertions passed | 71.377 seconds |

All complete-image cases ran without a server bind mount, using the original
five-second HTTP request limits. The constrained case took 93.538 seconds overall
and would fail the old startup gate; it now passes without retrying mutations.
The complete application artifact itself was not rebuilt or changed by this fix.

The proof is retained in the approved OpenCode temporary directory as
`wikisavvy-smoke-acceptance-20261117.json`, with per-case logs and a summary
`wikisavvy-smoke-acceptance-20261117.log`. Its script/helper SHA256 values were
checked against the final source bytes. Earlier failed-attempt evidence is
preserved separately, not overwritten.

Complete-image usage, tested against the existing local release artifact:

```sh
node --test scripts/wikisavvy-runtime-fixture.test.mjs
node scripts/test-wikisavvy-audit-runtime.mjs \
  --image sha256:1d2e9eb80ad567e828649433d5b5acc97b9efe25c47029b6ee5d4c5ac5c8713b
```

Without `--image`, the prior pinned runtime plus compiled-server bind-mount mode
is retained and was verified with all 28 assertions. Mutable tags, missing digests
and unknown arguments are rejected.
The selected image must already exist locally; the runner does not pull a
candidate from a registry.

Separate self-review inspected helper deadlines/cancellation, image selection,
failure redaction, retained assertions and fixture lifecycle. No new application
authorization or production behavior was changed. The historical setup/login
failure has not been causally reconstructed; passing repeats must not be described
as proof of its cause. Full backend/frontend builds and suites are not rerun for
this script-only slice; their previously recorded baseline remains applicable.

The reproduced startup-budget defect is fixed and the local release-smoke
acceptance gate now passes. This is not a guarantee against every future
environment failure. Any recurrence will retain its error type, allowlisted
transport code, fixed request path/status, assertion count and startup duration,
without recording credentials, response bodies or raw logs.

At local-fix completion, changes were uncommitted and no commit, push or deployment
was performed under that fix approval. The user subsequently requested release:
the fix was committed/pushed as `91f6cc88`, then deployed at 13:46 UTC under renewed
explicit `prd` approval, fresh preflight and restore/off-host-verified backup.
See the [deployment report](2026-11-17-wikisavvy-permission-foundation-deployment.md)
for the initial safe rollback, verifier-fixture recovery and successful retry.
Historical guard state and expired approvals must not be reused.
