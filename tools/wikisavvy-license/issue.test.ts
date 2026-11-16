import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { verifyLicense } from "../../packages/wikisavvy-license/src/index";

const directories: string[] = [];
const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const workspaceId = "11111111-1111-4111-8111-111111111111";
const claims = {
  version: 1,
  product: "wikisavvy",
  edition: "enterprise",
  licenseId: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  licensee: "CLI test",
  seats: 2,
  capabilities: [],
  issuedAt: "2026-11-01T00:00:00.000Z",
  notBefore: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
};
function invoke(value: unknown = claims, input = privatePem) {
  const directory = mkdtempSync(join(tmpdir(), "wikisavvy-license-"));
  directories.push(directory);
  const source = join(directory, "claims.json");
  const target = join(directory, "customer.license");
  writeFileSync(source, JSON.stringify(value), { mode: 0o600 });
  const args = [
    "--import",
    "tsx",
    resolve("tools/wikisavvy-license/issue.ts"),
    "--claims",
    source,
    "--kid",
    "primary",
    "--out",
    target,
  ];
  return {
    result: spawnSync(process.execPath, args, { input, encoding: "utf8" }),
    args,
    target,
  };
}
after(() => {
  for (const directory of directories) {
    for (const name of ["claims.json", "customer.license"]) {
      const path = join(directory, name);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(directory);
  }
});
describe("Offline license issuer CLI", () => {
  it("writes a private file without printing the private key or envelope", () => {
    const { result, target } = invoke();
    assert.equal(result.status, 0);
    const envelope = readFileSync(target, "utf8").trim();
    assert.equal(
      verifyLicense(envelope, { primary: publicPem }, workspaceId).licensee,
      "CLI test",
    );
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal((result.stdout + result.stderr).includes(privatePem), false);
    assert.equal((result.stdout + result.stderr).includes(envelope), false);
  });
  it("refuses to overwrite a license file", () => {
    const { args, target } = invoke();
    const before = readFileSync(target, "utf8");
    const retry = spawnSync(process.execPath, args, {
      input: privatePem,
      encoding: "utf8",
    });
    assert.equal(retry.status, 1);
    assert.equal(readFileSync(target, "utf8") === before, true);
  });
  it("rejects invalid claims and invalid signing material without disclosure", () => {
    for (const entry of [
      invoke({ ...claims, product: "docmost" }),
      invoke(claims, "invalid-private-input"),
    ]) {
      assert.equal(entry.result.status, 1);
      assert.equal(existsSync(entry.target), false);
      assert.equal(
        entry.result.stderr.includes("invalid-private-input"),
        false,
      );
    }
  });
});
