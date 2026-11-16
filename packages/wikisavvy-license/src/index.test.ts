import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import {
  issueLicense,
  verifyLicense,
  licenseState,
  effectiveCapabilities,
  hasSeat,
  type LicenseClaims,
} from "./index.ts";

const keys = generateKeyPairSync("ed25519");
const rotated = generateKeyPairSync("ed25519");
const publicPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const trust = { primary: publicPem };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const claims: LicenseClaims = {
  version: 1,
  product: "wikisavvy",
  edition: "enterprise",
  licenseId: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  licensee: "Example organization",
  seats: 2,
  capabilities: ["wikisavvy.page-permissions"],
  issuedAt: "2026-11-01T00:00:00.000Z",
  notBefore: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-12-01T00:00:00.000Z",
};
const issue = (value = claims) =>
  issueLicense(value, "primary", keys.privateKey);

describe("WikiSavvy offline licenses", () => {
  it("verifies a workspace-bound signature with its trusted public key", () => {
    assert.deepEqual(verifyLicense(issue(), trust, workspaceId), claims);
  });

  it("rejects payload tampering", () => {
    const parts = issue().split(".");
    parts[2] = Buffer.from(JSON.stringify({ ...claims, seats: 999 })).toString(
      "base64url",
    );
    assert.throws(() => verifyLicense(parts.join("."), trust, workspaceId));
  });

  it("binds the issuer identifier into the signature", () => {
    const value = issue().replace(".primary.", ".other.");
    assert.throws(() =>
      verifyLicense(value, { other: publicPem }, workspaceId),
    );
  });

  it("rejects a different workspace and an unknown issuer", () => {
    assert.throws(() =>
      verifyLicense(issue(), trust, "33333333-3333-4333-8333-333333333333"),
    );
    assert.throws(() => verifyLicense(issue(), {}, workspaceId));
  });

  it("supports a second explicitly trusted rotation key", () => {
    const pem = rotated.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const value = issueLicense(claims, "rotation", rotated.privateKey);
    assert.deepEqual(
      verifyLicense(value, { ...trust, rotation: pem }, workspaceId),
      claims,
    );
    assert.throws(() => verifyLicense(value, trust, workspaceId));
  });

  it("rejects wrong product, unknown capabilities, extra fields and invalid dates", () => {
    for (const value of [
      { ...claims, product: "docmost" },
      { ...claims, capabilities: ["unimplemented-arbitrary-flag"] },
      { ...claims, algorithm: "none" },
      { ...claims, expiresAt: claims.notBefore },
      { ...claims, seats: 0 },
      {
        ...claims,
        capabilities: [
          "wikisavvy.page-permissions",
          "wikisavvy.page-permissions",
        ],
      },
    ]) {
      assert.throws(() =>
        issueLicense(value as LicenseClaims, "primary", keys.privateKey),
      );
    }
  });

  it("validates the signed payload as well as the signature", () => {
    const payload = Buffer.from(
      JSON.stringify({ ...claims, product: "docmost" }),
    ).toString("base64url");
    const body = `wsv1.primary.${payload}`;
    const signature = sign(null, Buffer.from(body), keys.privateKey).toString(
      "base64url",
    );
    assert.throws(() =>
      verifyLicense(`${body}.${signature}`, trust, workspaceId),
    );
  });

  it("rejects oversized, malformed and noncanonical encodings", () => {
    for (const value of [
      "",
      "a".repeat(32769),
      "docmost-license",
      issue() + "=",
      issue() + ".extra",
    ]) {
      assert.throws(() => verifyLicense(value, trust, workspaceId));
    }
  });

  it("does not accept a private key as application trust configuration", () => {
    const privatePem = keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    assert.throws(() =>
      verifyLicense(issue(), { primary: privatePem }, workspaceId),
    );
    assert.throws(() =>
      verifyLicense(issue(), { primary: publicPem + privatePem }, workspaceId),
    );
  });

  it("requires Ed25519 rather than a caller-selected algorithm", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.throws(() => issueLicense(claims, "ec", ec.privateKey));
  });

  it("keeps future, valid, grace and expired boundaries precise", () => {
    assert.equal(
      licenseState(claims, new Date("2026-10-31T23:59:59Z")),
      "not-yet-valid",
    );
    assert.equal(licenseState(claims, new Date(claims.notBefore)), "valid");
    assert.equal(licenseState(claims, new Date(claims.expiresAt)), "grace");
    assert.equal(
      licenseState(claims, new Date("2026-12-30T23:59:59Z")),
      "grace",
    );
    assert.equal(
      licenseState(claims, new Date("2026-12-31T00:00:00Z")),
      "expired",
    );
  });

  it("never enables an unimplemented capability", () => {
    assert.deepEqual(effectiveCapabilities(claims, "valid"), []);
    assert.deepEqual(effectiveCapabilities(claims, "grace"), []);
    assert.deepEqual(effectiveCapabilities(claims, "expired"), []);
  });

  it("limits only new admissions during the valid and grace periods", () => {
    assert.equal(hasSeat(claims, "valid", 1), true);
    assert.equal(hasSeat(claims, "valid", 2), false);
    assert.equal(hasSeat(claims, "grace", 3), false);
    assert.equal(hasSeat(claims, "expired", 3), true);
    assert.equal(hasSeat({ ...claims, seats: null }, "valid", 500), true);
  });
});
