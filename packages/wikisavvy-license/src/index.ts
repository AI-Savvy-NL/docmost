import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

export const CAPABILITY_IDS: readonly string[] = Object.freeze(
  [
    "sso",
    "google-sso",
    "mfa",
    "scim",
    "api-keys",
    "oauth",
    "mcp",
    "mcp-controls",
    "page-permissions",
    "security-controls",
    "sharing-controls",
    "export-controls",
    "public-space-appearance",
    "audit-logs",
    "siem",
    "retention",
    "page-verification",
    "templates",
    "personal-spaces",
    "announcements",
    "comment-resolution",
    "viewer-comments",
    "bases",
    "confluence-import",
    "docx-import",
    "pdf-import",
    "pdf-export",
    "docx-export",
    "attachment-indexing",
    "typesense",
    "ai",
    "ai-controls",
    "integrations",
    "advanced-integrations",
  ].map((name) => `wikisavvy.${name}`),
);

export const GRACE_DAYS = 30;
export const MAX_LICENSE_LENGTH = 32768;
// A signed grant is not an implementation; register capabilities only after their independent backend and UI pass acceptance tests.
export const IMPLEMENTED_CAPABILITIES: readonly string[] = Object.freeze([]);
const kidPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const encodedPattern = /^[a-zA-Z0-9_-]+$/;
const claimsSchema = z
  .object({
    version: z.literal(1),
    product: z.literal("wikisavvy"),
    edition: z.literal("enterprise"),
    licenseId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    licensee: z.string().trim().min(1).max(200),
    seats: z.number().int().min(1).max(1000000).nullable(),
    capabilities: z
      .array(z.string().refine((value) => CAPABILITY_IDS.includes(value)))
      .max(CAPABILITY_IDS.length),
    issuedAt: z.string().datetime(),
    notBefore: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) =>
      Date.parse(value.issuedAt) <= Date.parse(value.notBefore) &&
      Date.parse(value.notBefore) < Date.parse(value.expiresAt) &&
      new Set(value.capabilities).size === value.capabilities.length,
  );

export type LicenseClaims = z.infer<typeof claimsSchema>;
export type LicenseState = "not-yet-valid" | "valid" | "grace" | "expired";
export type TrustedKeys = Readonly<Record<string, string>>;
export type LicenseStatus = {
  workspaceId: string;
  edition: "community" | "enterprise";
  status: LicenseState | "community" | "invalid";
  trustConfigured: boolean;
  features: string[];
  implementedCapabilities: string[];
  seats: { active: number; limit: number | null; overLimit: boolean };
  license: {
    licenseId: string;
    licensee: string;
    issuedAt: string;
    notBefore: string;
    expiresAt: string;
    graceEndsAt: string;
    capabilities: string[];
  } | null;
};

export class LicenseError extends Error {
  constructor() {
    super("Invalid or untrusted WikiSavvy license");
    this.name = "LicenseError";
  }
}

function parseClaims(value: unknown): LicenseClaims {
  const result = claimsSchema.safeParse(value);
  if (!result.success) throw new LicenseError();
  return result.data;
}

function decode(value: string): Buffer {
  if (!encodedPattern.test(value)) throw new LicenseError();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new LicenseError();
  return bytes;
}

export function issueLicense(
  claims: LicenseClaims,
  kid: string,
  privateKey: string | KeyObject,
): string {
  if (!kidPattern.test(kid)) throw new LicenseError();
  const parsed = parseClaims(claims);
  const key =
    typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new LicenseError();
  const payload = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  const body = `wsv1.${kid}.${payload}`;
  const result = `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`;
  if (result.length > MAX_LICENSE_LENGTH) throw new LicenseError();
  return result;
}

export function verifyLicense(
  value: string,
  trustedKeys: TrustedKeys,
  workspaceId: string,
): LicenseClaims {
  try {
    if (typeof value !== "string" || value.length > MAX_LICENSE_LENGTH)
      throw new LicenseError();
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "wsv1" || !kidPattern.test(parts[1]))
      throw new LicenseError();
    const [, kid, payload, signature] = parts;
    if (!Object.prototype.hasOwnProperty.call(trustedKeys, kid))
      throw new LicenseError();
    const pem = trustedKeys[kid];
    if (
      typeof pem !== "string" ||
      pem.length > 2048 ||
      pem.includes("PRIVATE KEY") ||
      !pem.startsWith("-----BEGIN PUBLIC KEY-----")
    )
      throw new LicenseError();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new LicenseError();
    const bytes = decode(payload);
    const signatureBytes = decode(signature);
    if (
      bytes.length > 16384 ||
      signatureBytes.length !== 64 ||
      !verify(
        null,
        Buffer.from(parts.slice(0, 3).join(".")),
        key,
        signatureBytes,
      )
    ) {
      throw new LicenseError();
    }
    const claims = parseClaims(JSON.parse(bytes.toString("utf8")));
    if (claims.workspaceId.toLowerCase() !== workspaceId.toLowerCase())
      throw new LicenseError();
    return claims;
  } catch {
    throw new LicenseError();
  }
}

export function graceEndsAt(claims: LicenseClaims): Date {
  return new Date(Date.parse(claims.expiresAt) + GRACE_DAYS * 86400000);
}

export function licenseState(
  claims: LicenseClaims,
  now = new Date(),
): LicenseState {
  if (now.getTime() < Date.parse(claims.notBefore)) return "not-yet-valid";
  if (now.getTime() < Date.parse(claims.expiresAt)) return "valid";
  if (now.getTime() < graceEndsAt(claims).getTime()) return "grace";
  return "expired";
}

export function effectiveCapabilities(
  claims: LicenseClaims,
  state: LicenseState,
): string[] {
  if (state !== "valid" && state !== "grace") return [];
  return claims.capabilities.filter((value) =>
    IMPLEMENTED_CAPABILITIES.includes(value),
  );
}

export function hasSeat(
  claims: LicenseClaims,
  state: LicenseState,
  activeMembers: number,
): boolean {
  return (
    (state !== "valid" && state !== "grace") ||
    claims.seats === null ||
    activeMembers < claims.seats
  );
}
