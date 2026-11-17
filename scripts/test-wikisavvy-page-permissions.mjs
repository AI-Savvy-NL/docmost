import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const name = `wikisavvy-permission-test-${randomUUID()}`;
const redisName = `${name}-redis`;
const password = randomBytes(32).toString("hex");
const image = "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc";
let created = false;
let redisCreated = false;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
try {
  const start = docker([
    "run", "--rm", "-d", "--name", name,
    "--label", "io.wikisavvy.test=page-permissions",
    "-p", "127.0.0.1::5432",
    "--tmpfs", "/var/lib/postgresql:rw,size=512m",
    "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=wikisavvy_permission_test", image,
  ], { ...process.env, POSTGRES_PASSWORD: password });
  if (start.status !== 0) throw new Error("Local permission fixture could not start");
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "wikisavvy_permission_test"]).status === 0) {
      ready = true;
      break;
    }
    await delay(500);
  }
  if (!ready) throw new Error("Local permission fixture did not become ready");
  const address = docker(["port", name, "5432/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Unexpected fixture bind address");
  const redis = docker([
    "run", "--rm", "-d", "--name", redisName,
    "--label", "io.wikisavvy.test=page-permissions",
    "-p", "127.0.0.1::6379",
    "redis@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe",
    "redis-server", "--save", "", "--appendonly", "no",
  ]);
  if (redis.status !== 0) throw new Error("Local Redis fixture could not start");
  redisCreated = true;
  const redisAddress = docker(["port", redisName, "6379/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(redisAddress)) throw new Error("Unexpected Redis fixture bind address");
  const result = spawnSync(process.execPath, [
    resolve("apps/server/node_modules/jest/bin/jest.js"),
    "--runInBand", "--runTestsByPath", "src/core/page-permissions/page-permission-policy.integration.spec.ts",
  ], {
    cwd: resolve("apps/server"),
    stdio: "inherit",
    env: {
      ...process.env,
      WIKISAVVY_PERMISSION_TEST_DATABASE_URL: `postgres://postgres:${password}@${address}/wikisavvy_permission_test`,
      WIKISAVVY_PERMISSION_TEST_REDIS_URL: `redis://${redisAddress}`,
    },
  });
  process.exitCode = result.status ?? 1;
} catch {
  console.error("Local permission integration fixture failed; credential-bearing diagnostics withheld.");
  process.exitCode = 1;
} finally {
  if (redisCreated && docker(["stop", "--time", "5", redisName]).status !== 0) {
    console.error(`Could not clean up the test container ${redisName}`);
    process.exitCode = 1;
  }
  if (created && docker(["stop", "--time", "5", name]).status !== 0) {
    console.error(`Could not clean up the test container ${name}`);
    process.exitCode = 1;
  }
}
