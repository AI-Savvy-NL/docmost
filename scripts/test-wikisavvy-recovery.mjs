import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const name = `wikisavvy-recovery-test-${randomUUID()}`;
const password = randomBytes(32).toString("hex");
const database = "wikisavvy_recovery_test";
const image =
  "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc";
let created = false;
let url;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
try {
  const started = docker(
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "--label",
      "io.wikisavvy.test=recovery",
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      `POSTGRES_DB=${database}`,
      image,
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  if (started.status !== 0) throw new Error();
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      docker(["exec", name, "pg_isready", "-U", "postgres", "-d", database])
        .status === 0
    ) {
      ready = true;
      break;
    }
    await delay(500);
  }
  if (!ready) throw new Error();
  const address = docker(["port", name, "5432/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error();
  url = `postgres://postgres:${password}@${address}/${database}`;
  const config = JSON.parse(
    readFileSync(resolve("apps/server/package.json"), "utf8"),
  ).jest;
  config.rootDir = resolve("apps/server/src");
  config.transform["^.+\\.(t|j)sx?$"] = [
    "ts-jest",
    { tsconfig: { allowJs: true, module: "CommonJS" } },
  ];
  config.transformIgnorePatterns = [
    "/node_modules/(?!(\\.pnpm/)?(nanoid|uuid|image-dimensions|marked|happy-dom|@fastify\\+cookie|@fastify/cookie|cookie)(@|/))",
  ];
  const result = spawnSync(
    process.execPath,
    [
      resolve("apps/server/node_modules/jest/bin/jest.js"),
      "--config",
      JSON.stringify(config),
      "--runInBand",
      "--runTestsByPath",
      "src/core/auth/services/password-reset.integration.spec.ts",
    ],
    {
      cwd: resolve("apps/server"),
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, WIKISAVVY_RECOVERY_TEST_DATABASE_URL: url },
    },
  );
  for (const output of [result.stdout, result.stderr]) {
    if (output)
      process.stdout.write(
        output
          .replaceAll(url, "[test database]")
          .replaceAll(password, "[redacted]"),
      );
  }
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Isolated recovery fixture failed; credential-bearing diagnostics withheld.",
  );
  process.exitCode = 1;
} finally {
  if (created && docker(["stop", "--timeout", "5", name]).status !== 0) {
    console.error(`Could not clean up owned recovery fixture ${name}`);
    process.exitCode = 1;
  }
}
