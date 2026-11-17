import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  releaseMetadata,
  dockerBuildArguments,
} from "./build-wikisavvy-release.mjs";

const revision = "7b93b5baad9ede5a15f5be5d78372dd0c0f0b027";

test("uses the UTC build date and committed revision", () => {
  assert.deepEqual(
    releaseMetadata(revision, new Date("2026-11-17T23:30:00-03:00")),
    {
      revision,
      date: "2026-11-18",
      version: "2026.11.18-7b93b5ba",
      image: "wikisavvy:2026.11.18-7b93b5ba",
    },
  );
});

test("a different committed change produces a different visible version", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  assert.notEqual(
    releaseMetadata(revision, now).version,
    releaseMetadata("1".repeat(40), now).version,
  );
});

test("rejects missing or malformed source identities and dates", () => {
  for (const value of ["", "HEAD", "7b93b5ba", "../" + revision]) {
    assert.throws(() => releaseMetadata(value, new Date()));
  }
  assert.throws(() => releaseMetadata(revision, new Date("invalid")));
});

test("passes identical baked application and OCI metadata without a shell", () => {
  const metadata = releaseMetadata(revision, new Date("2026-11-17T12:00:00Z"));
  assert.deepEqual(dockerBuildArguments(metadata, "/private/release source"), [
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `WIKISAVVY_BUILD_REVISION=${revision}`,
    "--build-arg",
    "WIKISAVVY_BUILD_DATE=2026-11-17",
    "--tag",
    "wikisavvy:2026.11.17-7b93b5ba",
    "/private/release source",
  ]);
});

test("Docker and CI propagate both release values to the final image", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  for (const name of ["Dockerfile", "Dockerfile.hardened"]) {
    const dockerfile = readFileSync(
      new URL(`../${name}`, import.meta.url),
      "utf8",
    );
    assert.match(dockerfile, /ARG WIKISAVVY_BUILD_REVISION/);
    assert.match(dockerfile, /ARG WIKISAVVY_BUILD_DATE/);
    assert.match(
      dockerfile,
      /ENV WIKISAVVY_BUILD_REVISION=\$WIKISAVVY_BUILD_REVISION/,
    );
    assert.match(dockerfile, /ENV WIKISAVVY_BUILD_DATE=\$WIKISAVVY_BUILD_DATE/);
    assert.match(
      dockerfile,
      /org\.opencontainers\.image\.revision="\$WIKISAVVY_BUILD_REVISION"/,
    );
  }
  assert.match(workflow, /WIKISAVVY_BUILD_REVISION=\$\{\{ github\.sha \}\}/);
  assert.match(
    workflow,
    /WIKISAVVY_BUILD_DATE=\$\{\{ steps\.release\.outputs\.date \}\}/,
  );
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wikisavvy-release-test-"));
  t.after(() => rmSync(root, { recursive: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const scripts = {
    git: `#!/bin/sh
case "$1" in
status) test "$WIKISAVVY_TEST_DIRTY" != 1 || printf ' M changed.ts\\n' ;;
rev-parse) printf '${revision}\\n' ;;
archive) printf '%s\\n' "$@" > "$WIKISAVVY_TEST_GIT_CAPTURE"; printf 'fixture archive' ;;
*) exit 9 ;;
esac
`,
    tar: "#!/bin/sh\nexit 0\n",
    docker: '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$WIKISAVVY_TEST_CAPTURE"\n',
  };
  for (const [name, content] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), content, { mode: 0o755 });
  }
  const capture = join(root, "docker-args");
  const gitCapture = join(root, "git-args");
  return {
    capture,
    gitCapture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: root,
      WIKISAVVY_TEST_CAPTURE: capture,
      WIKISAVVY_TEST_GIT_CAPTURE: gitCapture,
    },
  };
}

test("the CLI refuses dirty source before archiving or building", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-wikisavvy-release.mjs", import.meta.url))],
    {
      env: { ...f.env, WIKISAVVY_TEST_DIRTY: "1" },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /clean committed working tree/);
  assert.throws(() => readFileSync(f.capture));
  assert.throws(() => readFileSync(f.gitCapture));
});

test("the CLI archives the exact committed revision and builds that source", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-wikisavvy-release.mjs", import.meta.url))],
    {
      env: { ...f.env, WIKISAVVY_TEST_DIRTY: "0" },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.revision, revision);
  assert.equal(
    metadata.version,
    `${metadata.date.replaceAll("-", ".")}-7b93b5ba`,
  );
  assert.equal(
    readFileSync(f.gitCapture, "utf8"),
    `archive\n--format=tar\n${revision}\n`,
  );
  assert.deepEqual(
    readFileSync(f.capture, "utf8").trim().split("\n"),
    dockerBuildArguments(metadata, metadata.sourceDirectory),
  );
});
