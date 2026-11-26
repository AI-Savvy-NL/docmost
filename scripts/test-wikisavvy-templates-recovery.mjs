import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  APPLICATION_STARTUP_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  safeFixtureError,
  waitForReady,
} from "./wikisavvy-runtime-fixture.mjs";

const args = process.argv.slice(2);
assert.equal(
  args.length,
  6,
  "Use --image <digest> --recovery-image <digest> --legacy-image <digest>",
);
assert.equal(args[0], "--image");
assert.equal(args[2], "--recovery-image");
assert.equal(args[4], "--legacy-image");
for (const image of [args[1], args[3], args[5]])
  assert.match(image, /^sha256:[0-9a-f]{64}$/);
const [primary, recovery, legacy] = [args[1], args[3], args[5]];
const require = createRequire(resolve("apps/server/package.json"));
const postgres = require("postgres");
const suffix = randomUUID();
const names = {
  db: `wikisavvy-template-recovery-db-${suffix}`,
  redis: `wikisavvy-template-recovery-redis-${suffix}`,
  app: `wikisavvy-template-recovery-app-${suffix}`,
  legacy: `wikisavvy-template-recovery-legacy-${suffix}`,
};
const created = [];
const dbPassword = randomBytes(32).toString("hex");
const appSecret = randomBytes(32).toString("hex");
const loginPassword = randomBytes(24).toString("hex");
let sql;
let origin;
let stage = "isolated fixture startup";
let checks = 0;
let lastRequest;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
function check(condition) {
  assert.ok(condition, `Recovery assertion failed during ${stage}`);
  checks++;
}
function start(name, args, env, autoRemove = true) {
  const result = docker(
    [
      "run",
      ...(autoRemove ? ["--rm"] : []),
      "-d",
      "--name",
      name,
      "--label",
      "io.wikisavvy.test=templates-recovery",
      ...args,
    ],
    env,
  );
  assert.equal(result.status, 0, "Could not start local recovery fixture");
  created.push({ name, autoRemove });
}
function address(port) {
  const value = docker(["port", names.db, `${port}/tcp`]).stdout.trim();
  assert.match(value, /^127\.0\.0\.1:\d+$/);
  return value;
}
function stop(name) {
  const item = created.find((entry) => entry.name === name);
  if (!item) return;
  const state = docker(["inspect", "--format", "{{.State.Running}}", name]);
  if (state.status === 0 && state.stdout.trim() === "true") {
    assert.equal(
      docker(["stop", "--time", "10", name]).status,
      0,
      "Could not stop owned fixture",
    );
  }
  if (!item.autoRemove && state.status === 0) {
    assert.equal(
      docker(["rm", name]).status,
      0,
      "Could not remove owned fixture",
    );
  }
  created.splice(created.indexOf(item), 1);
}
function startApp(image, name = names.app, autoRemove = true) {
  start(
    name,
    [
      "--network",
      `container:${names.db}`,
      "--volumes-from",
      names.db,
      "-e",
      "DATABASE_URL",
      "-e",
      "APP_SECRET",
      "-e",
      "REDIS_URL=redis://127.0.0.1:6379",
      "-e",
      "APP_URL=http://localhost:3000",
      "-e",
      "NODE_ENV=production",
      "-e",
      "CLOUD=false",
      "-e",
      "DISABLE_TELEMETRY=true",
      image,
    ],
    {
      ...process.env,
      DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:5432/wikisavvy_template_recovery_test`,
      APP_SECRET: appSecret,
    },
    autoRemove,
  );
}
async function healthy() {
  await waitForReady(
    async () => {
      try {
        return (
          await fetch(`${origin}/api/health`, {
            signal: AbortSignal.timeout(2000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: APPLICATION_STARTUP_TIMEOUT_MS },
  );
}
async function request(path, body, cookie) {
  lastRequest = { path };
  const response = await fetch(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  lastRequest.status = response.status;
  return response;
}
async function success(path, body, cookie) {
  const response = await request(path, body, cookie);
  check(response.status === 200);
  return (await response.json()).data;
}
async function fingerprint() {
  const data = {
    templates: await sql`select * from templates order by id`,
    attachments: await sql`select * from attachments order by id`,
    pages:
      await sql`select id,slug_id,title,content,workspace_id,space_id,parent_page_id from pages order by id`,
    migrations: await sql`select * from kysely_migration order by name`,
  };
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
try {
  for (const image of [primary, recovery, legacy])
    check(docker(["image", "inspect", image]).status === 0);
  start(
    names.db,
    [
      "-p",
      "127.0.0.1::5432",
      "-p",
      "127.0.0.1::3000",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "--mount",
      "type=volume,destination=/app/data/storage",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=wikisavvy_template_recovery_test",
      "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc",
    ],
    { ...process.env, POSTGRES_PASSWORD: dbPassword },
  );
  // The volume belongs only to this disposable fixture; initialise app UID access.
  check(
    docker(["exec", names.db, "chown", "1000:1000", "/app/data/storage"])
      .status === 0,
  );
  await waitForReady(
    () =>
      docker(["exec", names.db, "pg_isready", "-U", "postgres"]).status === 0,
  );
  start(names.redis, [
    "--network",
    `container:${names.db}`,
    "redis@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe",
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  await waitForReady(
    () =>
      docker(["exec", names.redis, "redis-cli", "ping"]).stdout.trim() ===
      "PONG",
  );
  origin = `http://${address(3000)}`;
  sql = postgres(
    `postgres://postgres:${dbPassword}@${address(5432)}/wikisavvy_template_recovery_test`,
    { onnotice: () => {} },
  );
  startApp(primary);
  await healthy();
  stage = "create native template data and physical copies";
  const workspace = await success("auth/setup", {
    name: "Recovery owner",
    email: "template-recovery@example.invalid",
    password: loginPassword,
    workspaceName: "Template recovery fixture",
  });
  const login = await request("auth/login", {
    email: "template-recovery@example.invalid",
    password: loginPassword,
  });
  check(login.status === 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  check(cookie?.startsWith("authToken="));
  const space = (
    await sql`select id from spaces where workspace_id = ${workspace.id} limit 1`
  )[0];
  const source = await success(
    "pages/create",
    { title: "Recovery source", spaceId: space.id },
    cookie,
  );
  const bytes = Buffer.from("fixture bytes that must survive app rollback");
  const form = new FormData();
  form.append("pageId", source.id);
  form.append(
    "file",
    new Blob([bytes], { type: "application/octet-stream" }),
    "recovery.bin",
  );
  const uploaded = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: { cookie },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  check(uploaded.status === 200);
  const fileBody = await uploaded.json();
  const attachment = fileBody.data ?? fileBody;
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Preserved template content" }],
      },
      {
        type: "attachment",
        attrs: {
          attachmentId: attachment.id,
          url: `/api/files/${attachment.id}/recovery.bin`,
          name: "recovery.bin",
        },
      },
    ],
  };
  await sql`update pages set content = ${sql.json(content)} where id = ${source.id}`;
  const template = await success(
    "templates/create",
    {
      sourcePageId: source.id,
      confirmRestrictedSource: true,
    },
    cookie,
  );
  const page = await success(
    "templates/use",
    { templateId: template.id, spaceId: space.id },
    cookie,
  );
  const pageFile = (
    await sql`select id from attachments where page_id = ${page.id}`
  )[0];
  check(!!pageFile);
  stop(names.app);
  const before = await fingerprint();
  stage = "plain legacy image must refuse missing migration metadata";
  startApp(legacy, names.legacy, false);
  await waitForReady(() => {
    const result = docker(["logs", names.legacy]);
    return /previously executed migration .* is missing/.test(
      result.stdout + result.stderr,
    );
  });
  check(true);
  stop(names.legacy);
  check((await fingerprint()) === before);
  stage = "schema-aware previous-application recovery";
  startApp(recovery);
  await healthy();
  check(
    (await request("templates/info", { templateId: template.id }, cookie))
      .status === 404,
  );
  check(
    (await success("pages/info", { pageId: page.id }, cookie)).id === page.id,
  );
  const recoveredFile = await fetch(
    `${origin}/api/files/${pageFile.id}/recovery.bin`,
    {
      headers: { cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  check(
    recoveredFile.status === 200 &&
      Buffer.from(await recoveredFile.arrayBuffer()).equals(bytes),
  );
  check((await fingerprint()) === before);
  stop(names.app);
  stage = "forward return restores Templates without data loss";
  startApp(primary);
  await healthy();
  const restored = await success(
    "templates/info",
    { templateId: template.id },
    cookie,
  );
  check(JSON.stringify(restored.content) === JSON.stringify(template.content));
  const restoredId = restored.content.content.find(
    (node) => node.type === "attachment",
  ).attrs.attachmentId;
  const restoredFile = await fetch(
    `${origin}/api/templates/files/${restoredId}/recovery.bin`,
    {
      headers: { cookie },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  check(
    restoredFile.status === 200 &&
      Buffer.from(await restoredFile.arrayBuffer()).equals(bytes),
  );
  check((await fingerprint()) === before);
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      primary,
      recovery,
      legacyRefused: true,
      dataFingerprint: before,
    }),
  );
} catch (error) {
  console.error(
    "Template recovery rehearsal failed; credential-bearing diagnostics withheld.",
  );
  console.error(
    JSON.stringify({
      stage,
      checksCompleted: checks,
      error: safeFixtureError(error),
      lastRequest,
    }),
  );
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
  for (const item of [...created].reverse()) {
    try {
      stop(item.name);
    } catch {
      console.error(`Could not clean up owned fixture ${item.name}`);
      process.exitCode = 1;
    }
  }
}
