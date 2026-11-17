import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  APPLICATION_STARTUP_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  runtimeOptions,
  safeFixtureError,
  waitForReady as waitFor,
} from "./wikisavvy-runtime-fixture.mjs";

const runtime = runtimeOptions(process.argv.slice(2));
const require = createRequire(resolve("apps/server/package.json"));
const postgres = require("postgres");
const jwt = require("jsonwebtoken");
const suffix = randomUUID();
const names = {
  db: `wikisavvy-audit-runtime-db-${suffix}`,
  redis: `wikisavvy-audit-runtime-redis-${suffix}`,
  app: `wikisavvy-audit-runtime-app-${suffix}`,
};
const created = [];
const dbPassword = randomBytes(32).toString("hex");
const appSecret = randomBytes(32).toString("hex");
const loginPassword = randomBytes(24).toString("hex");
const dbImage = "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc";
const redisImage = "redis@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe";
const runtimeImage = runtime.image;
let sql;
let stage = "fixture startup";
let checks = 0;
let startupStartedAt;
let startupDurationMs;
let lastRequest;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
function checkLocalImage() {
  assert.equal(docker(["image", "inspect", runtimeImage]).status, 0,
    "Selected runtime image is not available locally");
}
function start(name, args, env) {
  const result = docker(["run", "--rm", "-d", "--name", name, "--label", "io.wikisavvy.test=audit-runtime", ...args], env);
  assert.equal(result.status, 0, "A local fixture could not start");
  created.push(name);
}
function address(port) {
  const result = docker(["port", names.db, `${port}/tcp`]).stdout.trim();
  assert.match(result, /^127\.0\.0\.1:\d+$/, "Unexpected fixture bind address");
  return result;
}
function check(condition) {
  assert.ok(condition, "Runtime assertion failed");
  checks++;
}

try {
  checkLocalImage();
  start(names.db, [
    "-p", "127.0.0.1::5432", "-p", "127.0.0.1::3000",
    "--tmpfs", "/var/lib/postgresql:rw,size=512m",
    "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=wikisavvy_audit_runtime_test", dbImage,
  ], { ...process.env, POSTGRES_PASSWORD: dbPassword });
  await waitFor(() => docker(["exec", names.db, "pg_isready", "-U", "postgres", "-d", "wikisavvy_audit_runtime_test"]).status === 0);
  start(names.redis, ["--network", `container:${names.db}`, redisImage, "redis-server", "--save", "", "--appendonly", "no"]);
  await waitFor(() => docker(["exec", names.redis, "redis-cli", "ping"]).stdout.trim() === "PONG");
  const databaseUrl = `postgres://postgres:${dbPassword}@127.0.0.1:5432/wikisavvy_audit_runtime_test`;
  start(names.app, [
    "--network", `container:${names.db}`,
    ...(runtime.bindCompiledServer
      ? ["--mount", `type=bind,src=${resolve("apps/server/dist")},dst=/app/apps/server/dist,readonly`]
      : []),
    "--tmpfs", "/app/data/storage:rw,uid=1000,gid=1000,size=64m",
    "-e", "DATABASE_URL", "-e", "APP_SECRET",
    "-e", "REDIS_URL=redis://127.0.0.1:6379",
    "-e", "APP_URL=http://localhost:3000", "-e", "DISABLE_TELEMETRY=true",
    "-e", "CLOUD=false", "-e", "NODE_ENV=production", runtimeImage,
  ], { ...process.env, DATABASE_URL: databaseUrl, APP_SECRET: appSecret });
  startupStartedAt = performance.now();
  const origin = `http://${address(3000)}`;
  async function request(path, body, cookie) {
    lastRequest = { path };
    const response = await fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    lastRequest.status = response.status;
    return response;
  }
  stage = "application bootstrap and migrations";
  await waitFor(async () => {
    try {
      return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch { return false; }
  }, { timeoutMs: APPLICATION_STARTUP_TIMEOUT_MS });
  startupDurationMs = Math.round(performance.now() - startupStartedAt);
  sql = postgres(`postgres://postgres:${dbPassword}@${address(5432)}/wikisavvy_audit_runtime_test`, { onnotice: () => {} });
  check((await sql`select name from kysely_migration`).length === 62);
  stage = "real setup and login";
  const setup = await request("auth/setup", {
    name: "Audit fixture owner", email: "audit-owner@example.invalid",
    password: loginPassword, workspaceName: "Audit runtime fixture",
  });
  check(setup.status === 200);
  const workspaceId = (await setup.json()).data.id;
  const owner = (await sql`select id from users where email = 'audit-owner@example.invalid'`)[0];
  const login = await request("auth/login", { email: "audit-owner@example.invalid", password: loginPassword });
  check(login.status === 200);
  const ownerCookie = login.headers.get("set-cookie")?.split(";")[0];
  check(ownerCookie?.startsWith("authToken="));
  stage = "owner and anonymous audit history";
  check((await request("wikisavvy/audit/history", {})).status === 401);
  await waitFor(async () => (await sql`select id from audit where event = 'user.login' and actor_id = ${owner.id}`).length > 0);
  const history = await request("wikisavvy/audit/history", {}, ownerCookie);
  check(history.status === 200);
  const page = (await history.json()).data;
  check(page.items.some((row) => row.event === "user.login" && row.actorId === owner.id));
  check(page.captureStatus.recorded > 0);
  check(page.items.every((row) => !("metadata" in row) && !("userAgent" in row) && !("changes" in row) && !("ipAddress" in row)));
  check(!JSON.stringify(page).includes("audit-owner@example.invalid"));
  stage = "member and administrator denial";
  for (const role of ["member", "admin"]) {
    const email = `audit-${role}@example.invalid`;
    await sql`insert into users (name,email,password,role,workspace_id,email_verified_at)
      select ${role},${email},password,${role},workspace_id,now() from users where id = ${owner.id}`;
    const response = await request("auth/login", { email, password: loginPassword });
    check(response.status === 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    check((await request("wikisavvy/audit/history", {}, cookie)).status === 403);
  }
  stage = "pagination validation";
  for (const body of [{ limit: 101 }, { cursor: "invalid" }, { cursor: "x", beforeCursor: "y" }]) {
    check((await request("wikisavvy/audit/history", body, ownerCookie)).status === 400);
  }
  stage = "workspace isolation and credential types";
  const otherWorkspace = randomUUID();
  const foreignRecord = randomUUID();
  await sql`insert into workspaces (id,name) values (${otherWorkspace},'Other fixture workspace')`;
  await sql`insert into audit (id,workspace_id,event,resource_type) values (${foreignRecord},${otherWorkspace},'user.login','user')`;
  const scoped = await request("wikisavvy/audit/history", { workspaceId: otherWorkspace }, ownerCookie);
  check(scoped.status === 200);
  check(!(await scoped.json()).data.items.some((row) => row.id === foreignRecord));
  const legacyToken = jwt.sign({ sub: owner.id, workspaceId, type: "access" }, appSecret, { expiresIn: "1m" });
  check((await request("wikisavvy/audit/history", {}, `authToken=${legacyToken}`)).status === 403);
  for (const type of ["api_key", "oauth_access", "mfa_token"]) {
    const token = jwt.sign({ sub: owner.id, workspaceId, type }, appSecret, { expiresIn: "1m" });
    check((await request("wikisavvy/audit/history", {}, `authToken=${token}`)).status === 401);
  }
  const crossToken = jwt.sign({ sub: owner.id, workspaceId: otherWorkspace, type: "access" }, appSecret, { expiresIn: "1m" });
  check((await request("wikisavvy/audit/history", {}, `authToken=${crossToken}`)).status === 401);
  stage = "non-blocking persistence failure";
  await sql`create function fail_audit_fixture() returns trigger language plpgsql as $$
    begin raise exception 'synthetic-sensitive-audit-error'; end $$`;
  await sql`create trigger fail_audit_fixture before insert on audit for each row execute function fail_audit_fixture()`;
  const degradedLogin = await request("auth/login", { email: "audit-owner@example.invalid", password: loginPassword });
  check(degradedLogin.status === 200);
  await waitFor(async () => {
    const response = await request("wikisavvy/audit/history", {}, ownerCookie);
    return response.ok && (await response.json()).data.captureStatus.failed > 0;
  });
  check(!docker(["logs", names.app]).stdout.includes("synthetic-sensitive-audit-error"));
  check(!docker(["logs", names.app]).stderr.includes("synthetic-sensitive-audit-error"));
  stage = "session revocation";
  await sql`update user_sessions set revoked_at = now() where user_id = ${owner.id}`;
  check((await request("wikisavvy/audit/history", {}, ownerCookie)).status === 401);
  const mode = runtime.bindCompiledServer ? "current compiled server" : "complete release image";
  console.log(`Audit runtime: ${checks} checks passed; ${mode}, real sessions, 62 migrations, isolated PostgreSQL/Redis.`);
  console.log(JSON.stringify({
    passed: true, checks, image: runtimeImage,
    serverBindMount: runtime.bindCompiledServer, startupDurationMs,
  }));
} catch (error) {
  console.error(`Audit runtime failed during ${stage}; raw credential-bearing diagnostics withheld.`);
  console.error(JSON.stringify({
    stage, checksCompleted: checks, error: safeFixtureError(error), lastRequest,
    startupElapsedMs: startupStartedAt === undefined ? undefined
      : startupDurationMs ?? Math.round(performance.now() - startupStartedAt),
  }));
  if (created.includes(names.app)) {
    const result = docker(["logs", names.app]);
    const logs = result.stdout + result.stderr;
    for (const [label, pattern] of [
      ["Nest dependency resolution failure", /UnknownDependenciesException|Nest can't resolve dependencies/],
      ["Missing runtime module", /Cannot find module/],
      ["Migration failure", /Failed to execute migration/],
      ["Database connection failure", /Failed to connect to database/],
    ]) {
      if (pattern.test(logs)) console.error(label);
    }
  }
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
  for (const name of created.reverse()) {
    if (docker(["stop", "--time", "5", name]).status !== 0) {
      console.error(`Could not clean up the test container ${name}`);
      process.exitCode = 1;
    }
  }
}
