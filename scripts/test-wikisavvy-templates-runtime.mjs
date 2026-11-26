import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  APPLICATION_STARTUP_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  runtimeOptions,
  safeFixtureError,
  waitForReady,
} from "./wikisavvy-runtime-fixture.mjs";

const runtime = runtimeOptions(process.argv.slice(2));
assert.equal(
  runtime.bindCompiledServer,
  false,
  "Select a complete release image with --image",
);
const require = createRequire(resolve("apps/server/package.json"));
const postgres = require("postgres");
const suffix = randomUUID();
const names = {
  db: `wikisavvy-template-runtime-db-${suffix}`,
  redis: `wikisavvy-template-runtime-redis-${suffix}`,
  app: `wikisavvy-template-runtime-app-${suffix}`,
};
const created = [];
const dbPassword = randomBytes(32).toString("hex");
const appSecret = randomBytes(32).toString("hex");
const loginPassword = randomBytes(24).toString("hex");
let sql;
let checks = 0;
let stage = "fixture startup";
let lastRequest;
function docker(args, env = process.env) {
  return spawnSync("docker", args, { env, encoding: "utf8", timeout: 30000 });
}
function start(name, args, env) {
  const result = docker(
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "--label",
      "io.wikisavvy.test=templates-runtime",
      ...args,
    ],
    env,
  );
  assert.equal(result.status, 0, "A local fixture could not start");
  created.push(name);
}
function address(port) {
  const value = docker(["port", names.db, `${port}/tcp`]).stdout.trim();
  assert.match(value, /^127\.0\.0\.1:\d+$/);
  return value;
}
function check(value) {
  assert.ok(value, `Runtime assertion failed during ${stage}`);
  checks++;
}
try {
  check(docker(["image", "inspect", runtime.image]).status === 0);
  start(
    names.db,
    [
      "-p",
      "127.0.0.1::5432",
      "-p",
      "127.0.0.1::3000",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=wikisavvy_template_runtime_test",
      "postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc",
    ],
    { ...process.env, POSTGRES_PASSWORD: dbPassword },
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
  start(
    names.app,
    [
      "--network",
      `container:${names.db}`,
      "--tmpfs",
      "/app/data/storage:rw,uid=1000,gid=1000,size=64m",
      "-e",
      "DATABASE_URL",
      "-e",
      "APP_SECRET",
      "-e",
      "REDIS_URL=redis://127.0.0.1:6379",
      "-e",
      "APP_URL=http://localhost:3000",
      "-e",
      "DISABLE_TELEMETRY=true",
      "-e",
      "CLOUD=false",
      "-e",
      "NODE_ENV=production",
      runtime.image,
    ],
    {
      ...process.env,
      DATABASE_URL: `postgres://postgres:${dbPassword}@127.0.0.1:5432/wikisavvy_template_runtime_test`,
      APP_SECRET: appSecret,
    },
  );
  const origin = `http://${address(3000)}`;
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
  async function file(path, cookie) {
    return fetch(`${origin}${path}`, {
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
  stage = "bootstrap and real migrations";
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
  sql = postgres(
    `postgres://postgres:${dbPassword}@${address(5432)}/wikisavvy_template_runtime_test`,
    { onnotice: () => {} },
  );
  const expected = readdirSync("apps/server/src/database/migrations")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort();
  const applied = (
    await sql`select name from kysely_migration order by name`
  ).map((row) => row.name);
  check(JSON.stringify(applied) === JSON.stringify(expected));
  stage = "real account setup and persisted sessions";
  const workspace = await success("auth/setup", {
    name: "Template fixture owner",
    email: "template-owner@example.invalid",
    password: loginPassword,
    workspaceName: "Template runtime fixture",
  });
  const workspaceId = workspace.id;
  async function login(email) {
    const response = await request("auth/login", {
      email,
      password: loginPassword,
    });
    check(response.status === 200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    check(cookie?.startsWith("authToken="));
    return cookie;
  }
  const ownerCookie = await login("template-owner@example.invalid");
  const owner = (
    await sql`select id from users where workspace_id = ${workspaceId} and role = 'owner'`
  )[0];
  const space = (
    await sql`select id from spaces where workspace_id = ${workspaceId} and deleted_at is null limit 1`
  )[0];
  check(!!space);
  await sql`update spaces set visibility = 'open', is_personal = false where id = ${space.id}`;
  const actors = {};
  for (const role of ["member", "admin"]) {
    const id = randomUUID();
    const email = `template-${role}@example.invalid`;
    await sql`insert into users (id,name,email,password,role,workspace_id,email_verified_at)
      select ${id},${role},${email},password,${role},workspace_id,now() from users where id = ${owner.id}`;
    await sql`insert into space_members (space_id,user_id,role,added_by_id) values (${space.id},${id},'writer',${owner.id})`;
    actors[role] = { id, cookie: await login(email) };
  }
  const destination = await success(
    "spaces/create",
    {
      name: "Template destinations",
      slug: "template-destinations",
    },
    ownerCookie,
  );
  check(!!destination.id);
  for (const actor of Object.values(actors)) {
    await sql`insert into space_members (space_id,user_id,role,added_by_id)
      values (${destination.id},${actor.id},'writer',${owner.id})`;
  }
  stage = "native template source and independently copied file";
  const source = await success(
    "pages/create",
    { title: "Source snapshot", spaceId: space.id },
    ownerCookie,
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
    "base64",
  );
  const form = new FormData();
  form.append("pageId", source.id);
  form.append("file", new Blob([png], { type: "image/png" }), "source.png");
  const upload = await fetch(`${origin}/api/files/upload`, {
    method: "POST",
    headers: { cookie: ownerCookie },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  check(upload.status === 200);
  const uploaded = await upload.json();
  const attachment = uploaded.data ?? uploaded;
  check(!!attachment.id);
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Durable snapshot body" }],
      },
      {
        type: "image",
        attrs: {
          attachmentId: attachment.id,
          src: `/api/files/${attachment.id}/source.png`,
        },
      },
    ],
  };
  await sql`update pages set content = ${sql.json(content)} where id = ${source.id}`;
  const template = await success(
    "templates/create",
    { sourcePageId: source.id },
    actors.member.cookie,
  );
  check(template.spaceId === null && template.creatorId === actors.member.id);
  const image = template.content.content.find((node) => node.type === "image");
  check(image.attrs.attachmentId !== attachment.id);
  const owned = (
    await sql`select * from attachments where id = ${image.attrs.attachmentId}`
  )[0];
  check(
    owned.template_id === template.id &&
      owned.page_id === null &&
      owned.space_id === null &&
      owned.ai_chat_id === null,
  );
  let bytes = await file(image.attrs.src, actors.admin.cookie);
  check(
    bytes.status === 200 && Buffer.from(await bytes.arrayBuffer()).equals(png),
  );
  check(bytes.headers.get("cache-control") === "private, no-store");
  check((await file(image.attrs.src)).status === 401);
  stage = "restricted-source publication and management authorization";
  const accessId = randomUUID();
  await sql`insert into page_access (id,page_id,space_id,workspace_id,access_level,creator_id)
    values (${accessId},${source.id},${space.id},${workspaceId},'restricted',${owner.id})`;
  for (const id of [owner.id, actors.member.id, actors.admin.id]) {
    await sql`insert into page_permissions (page_access_id,user_id,role,added_by_id) values (${accessId},${id},'writer',${owner.id})`;
  }
  for (const confirmed of [false, true]) {
    check(
      (
        await request(
          "templates/create",
          { sourcePageId: source.id, confirmRestrictedSource: confirmed },
          actors.member.cookie,
        )
      ).status === 403,
    );
  }
  check(
    (
      await request(
        "templates/create",
        { sourcePageId: source.id },
        actors.admin.cookie,
      )
    ).status === 403,
  );
  const confirmed = await success(
    "templates/create",
    { sourcePageId: source.id, confirmRestrictedSource: true },
    actors.admin.cookie,
  );
  check(confirmed.creatorId === actors.admin.id);
  await sql`delete from page_permissions where page_access_id = ${accessId} and user_id = ${actors.admin.id}`;
  check(
    (
      await request(
        "templates/create",
        { sourcePageId: source.id, confirmRestrictedSource: true },
        actors.admin.cookie,
      )
    ).status === 403,
  );
  check(
    (
      await request(
        "templates/update",
        { templateId: confirmed.id, title: "not mine" },
        actors.member.cookie,
      )
    ).status === 403,
  );
  const otherWorkspace = randomUUID();
  const foreignTemplate = randomUUID();
  await sql`insert into workspaces (id,name) values (${otherWorkspace},'Other fixture')`;
  await sql`insert into templates (id,workspace_id,title) values (${foreignTemplate},${otherWorkspace},'Foreign')`;
  check(
    (
      await request(
        "templates/info",
        { templateId: foreignTemplate },
        ownerCookie,
      )
    ).status === 404,
  );
  check(
    (
      await request(
        "templates/use",
        { templateId: foreignTemplate, spaceId: space.id },
        ownerCookie,
      )
    ).status === 404,
  );
  stage = "document validation, real page creation and target-file ownership";
  check(
    (
      await request(
        "templates/update",
        {
          templateId: template.id,
          content: { type: "doc", content: [{ type: "unknown-fixture-node" }] },
        },
        actors.member.cookie,
      )
    ).status === 400,
  );
  const createdPage = await success(
    "templates/use",
    { templateId: template.id, spaceId: destination.id },
    actors.member.cookie,
  );
  const pageFile = (
    await sql`select * from attachments where page_id = ${createdPage.id}`
  )[0];
  check(pageFile && pageFile.template_id === null && pageFile.id !== owned.id);
  const pageInfo = await success(
    "pages/info",
    { pageId: createdPage.id },
    actors.member.cookie,
  );
  check(JSON.stringify(pageInfo.content).includes(pageFile.id));
  const ydoc = (
    await sql`select ydoc from pages where id = ${createdPage.id}`
  )[0].ydoc;
  check(ydoc && ydoc.length > 0);
  const emptyPage = await success(
    "pages/create",
    { title: "Empty picker target", spaceId: destination.id },
    actors.member.cookie,
  );
  const prepared = await success(
    "templates/prepare",
    { templateId: template.id, pageId: emptyPage.id },
    actors.member.cookie,
  );
  const preparedImage = prepared.content.content.find(
    (node) => node.type === "image",
  );
  check(
    (
      await sql`select page_id from attachments where id = ${preparedImage.attrs.attachmentId}`
    )[0].page_id === emptyPage.id,
  );
  await sql`update space_members set role = 'reader' where user_id = ${actors.member.id} and space_id = ${destination.id}`;
  check(
    (
      await request(
        "templates/use",
        { templateId: template.id, spaceId: destination.id },
        actors.member.cookie,
      )
    ).status === 403,
  );
  await sql`update space_members set role = 'writer' where user_id = ${actors.member.id} and space_id = ${destination.id}`;
  stage = "source-page and source-space independence";
  const original = (
    await sql`select file_path from attachments where id = ${attachment.id}`
  )[0];
  check(
    original.file_path.startsWith(`${workspaceId}/files/${attachment.id}/`),
  );
  check(
    docker([
      "exec",
      names.app,
      "node",
      "-e",
      "require('node:fs').unlinkSync('/app/data/storage/'+process.argv[1])",
      original.file_path,
    ]).status === 0,
  );
  await sql`delete from attachments where id = ${attachment.id}`;
  await sql`delete from pages where id = ${source.id}`;
  await sql`delete from spaces where id = ${space.id}`;
  bytes = await file(image.attrs.src, ownerCookie);
  check(
    bytes.status === 200 && Buffer.from(await bytes.arrayBuffer()).equals(png),
  );
  check(
    (await success("templates/info", { templateId: template.id }, ownerCookie))
      .id === template.id,
  );
  stage = "soft deletion, independent target page and sanitized audit";
  await success(
    "templates/delete",
    { templateId: template.id },
    actors.member.cookie,
  );
  check(
    (await request("templates/info", { templateId: template.id }, ownerCookie))
      .status === 404,
  );
  check((await file(image.attrs.src, ownerCookie)).status === 404);
  bytes = await file(
    `/api/files/${pageFile.id}/source.png`,
    actors.member.cookie,
  );
  check(
    bytes.status === 200 && Buffer.from(await bytes.arrayBuffer()).equals(png),
  );
  const listing = await success("templates", {}, actors.member.cookie);
  check(
    !listing.items.some(
      (row) => row.id === template.id || row.id === foreignTemplate,
    ),
  );
  await waitForReady(
    async () =>
      (
        await sql`select id from audit where event = 'template.deleted' and resource_id = ${template.id}`
      ).length > 0,
  );
  const audits =
    await sql`select metadata from audit where event in ('template.created','template.deleted') and workspace_id = ${workspaceId}`;
  check(audits.length >= 3);
  check(!JSON.stringify(audits).includes("Durable snapshot body"));
  stage = "persisted session revocation";
  await sql`update user_sessions set revoked_at = now() where user_id = ${actors.member.id}`;
  check((await request("templates", {}, actors.member.cookie)).status === 401);
  console.log(
    JSON.stringify({
      passed: true,
      checks,
      image: runtime.image,
      serverBindMount: false,
      migrations: applied.length,
    }),
  );
} catch (error) {
  console.error(
    "Template runtime failed; credential-bearing diagnostics withheld.",
  );
  console.error(
    JSON.stringify({
      stage,
      checksCompleted: checks,
      error: safeFixtureError(error),
      lastRequest,
    }),
  );
  if (created.includes(names.app)) {
    const logs = docker(["logs", names.app]);
    const text = logs.stdout + logs.stderr;
    for (const [label, pattern] of [
      [
        "Nest dependency resolution failure",
        /UnknownDependenciesException|Nest can't resolve dependencies/,
      ],
      ["Missing runtime module", /Cannot find module/],
      ["Migration failure", /Failed to execute migration/],
    ])
      if (pattern.test(text)) console.error(label);
  }
  process.exitCode = 1;
} finally {
  if (sql) await sql.end({ timeout: 5 });
  for (const name of created.reverse()) {
    if (docker(["stop", "--time", "5", name]).status !== 0) {
      console.error(`Could not clean up test container ${name}`);
      process.exitCode = 1;
    }
  }
}
