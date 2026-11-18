import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";

const load = createRequire(
  new URL("../apps/server/package.json", import.meta.url),
);
const issuer = "https://identity.example.invalid/application/o/wiki/";
const callback = "https://wiki.example.invalid/api/oidc/callback";
const clientId = "native-fixture";
const clientSecret = randomBytes(32).toString("base64url");
let phase = "load compiled adapter";
try {
  const { WikisavvyOidcProtocol } = load("./dist/core/oidc/oidc-protocol.js");
  const { WikisavvyOidcHttp } = load("./dist/core/oidc/oidc-http.js");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "native-fixture",
    alg: "RS256",
    use: "sig",
  };
  const http = new WikisavvyOidcHttp(
    { getOidcAllowedOrigins: () => "https://identity.example.invalid" },
    {},
  );
  let nonce = "";
  let challenge = "";
  let tampered = false;
  http.fetch = async (_issuer, url, options) => {
    if (url.includes(".well-known/openid-configuration"))
      return Response.json({
        issuer,
        authorization_endpoint: "https://identity.example.invalid/authorize",
        token_endpoint: "https://identity.example.invalid/token",
        jwks_uri: "https://identity.example.invalid/jwks",
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/token")) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_secret") === clientSecret, true);
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url") === challenge,
        true,
      );
      assert.equal(body.get("redirect_uri") === callback, true);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "native-fixture" }),
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: "native-subject",
          aud: clientId,
          nonce,
          iat: now,
          exp: now + 120,
        }),
      ).toString("base64url");
      const input = `${header}.${payload}`;
      let signature = sign(
        "RSA-SHA256",
        Buffer.from(input),
        keys.privateKey,
      ).toString("base64url");
      if (tampered)
        signature = (signature[0] === "a" ? "b" : "a") + signature.slice(1);
      return Response.json({
        access_token: "synthetic-provider-proof",
        token_type: "Bearer",
        id_token: `${input}.${signature}`,
      });
    }
    throw new Error("Unexpected controlled endpoint");
  };
  const protocol = new WikisavvyOidcProtocol(http);
  const provider = { issuer, clientId, clientSecret };
  phase = "authorization request";
  const proof = await protocol.start(provider, callback);
  const request = new URL(proof.authorizationUrl);
  nonce = request.searchParams.get("nonce");
  challenge = request.searchParams.get("code_challenge");
  const response = new URL(callback);
  response.searchParams.set("code", "synthetic-native-code");
  response.searchParams.set("state", proof.state);
  phase = "signed identity verification";
  assert.deepEqual(await protocol.complete(provider, response, proof), {
    issuer,
    subject: "native-subject",
  });
  tampered = true;
  phase = "invalid signature rejection";
  let rejected = false;
  try {
    await protocol.complete(provider, response, proof);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
  console.log(
    JSON.stringify({
      runtime: process.version,
      compiledNativeSdk: "passed",
      validSignature: "accepted",
      invalidSignature: "rejected",
      network: "controlled responses only",
    }),
  );
} catch {
  console.error(
    `Native OIDC smoke failed at ${phase}; proof-bearing diagnostics withheld.`,
  );
  process.exitCode = 1;
}
