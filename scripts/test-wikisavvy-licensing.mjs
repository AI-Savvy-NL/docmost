import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const name = `wikisavvy-license-test-${randomUUID()}`;
const password = randomBytes(32).toString("hex");
const image =
  "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc";
let created = false;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
try {
  const start = docker(
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "--label",
      "io.wikisavvy.test=licensing",
      "-p",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=wikisavvy_test",
      image,
    ],
    { ...process.env, POSTGRES_PASSWORD: password },
  );
  if (start.status !== 0)
    throw new Error("Local PostgreSQL fixture could not start");
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      docker([
        "exec",
        name,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "wikisavvy_test",
      ]).status === 0
    ) {
      ready = true;
      break;
    }
    await delay(500);
  }
  if (!ready) throw new Error("Local PostgreSQL fixture did not become ready");
  const address = docker(["port", name, "5432/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address))
    throw new Error("Unexpected fixture bind address");
  const result = spawnSync(
    process.execPath,
    [
      resolve("apps/server/node_modules/jest/bin/jest.js"),
      "--runInBand",
      "--runTestsByPath",
      "src/core/licensing/licensing.integration.spec.ts",
    ],
    {
      cwd: resolve("apps/server"),
      stdio: "inherit",
      env: {
        ...process.env,
        WIKISAVVY_TEST_DATABASE_URL: `postgres://postgres:${password}@${address}/wikisavvy_test`,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} catch {
  console.error(
    "Local licensing integration fixture failed; credential-bearing diagnostics withheld.",
  );
  process.exitCode = 1;
} finally {
  if (created && docker(["stop", "--time", "5", name]).status !== 0) {
    console.error(`Could not clean up the test container ${name}`);
    process.exitCode = 1;
  }
}
