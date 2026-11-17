# WikiSavvy offline licenses

The implemented-capability registry currently contains only
`wikisavvy.page-permissions`. A valid Enterprise license does not
unlock Docmost's separately licensed code or change its license terms.

## Issuing a license

Run the issuer on a separate offline/operator machine. Supply an Ed25519 PKCS8
private PEM through standard input, not a command argument. Never put the private
key in this repository, a container image, application configuration, or logs.

```sh
pnpm license:issue --claims claims.json --kid production-1 --out customer.license < /secure/offline/issuer.pem
```

`claims.json` contains `version: 1`, `product: "wikisavvy"`,
`edition: "enterprise"`, UUID `licenseId` and `workspaceId`, a `licensee` name,
`seats` (positive integer or `null` for unlimited), `capabilities`, and UTC
`issuedAt`, `notBefore`, `expiresAt` timestamps. Copy the workspace ID from the
License & Edition page. Dates must satisfy `issuedAt <= notBefore < expiresAt`.
Capability names are allowlisted in `packages/wikisavvy-license/src/index.ts`.
Grant `wikisavvy.page-permissions` to enable creation of new direct page
restrictions. Maintenance/removal and enforcement of existing restrictions do not
depend on license validity. Other known grants remain unavailable until their
independent implementations pass acceptance.

The issuer writes an exclusive mode-0600 output file and never prints the key
or envelope. To renew, issue a new license file; an existing file is not overwritten.

## Configuring an application

Set `WIKISAVVY_LICENSE_PUBLIC_KEYS_FILE` to a JSON file mapping issuer identifiers
to Ed25519 SPKI public PEM strings. Mount that file read-only into the application.
It contains **public keys only**; private PEMs are rejected.

The application re-reads this file when verifying a license. During key rotation,
keep the old and new public entries until licenses signed by the old key no longer
need verification. Unknown identifiers and malformed/missing trust files never
grant Enterprise access. There is no mandatory licensing-server connection.

Apply the additive database migration before starting this build. Workspace owners
can install, renew or remove licenses at **Settings → License & Edition**.
The authenticated owner-only POST endpoints are:

- `/api/wikisavvy/licensing/status`
- `/api/wikisavvy/licensing/activate` with a `license` string in the JSON body
- `/api/wikisavvy/licensing/remove`

Status never returns the stored envelope. Envelopes use the application's existing
authenticated encryption with a separate purpose; preserve `APP_SECRET` in backups.
Activation/removal events retain only actor, time, action and a license fingerprint.

## Seats and expiry

Active non-deleted accounts count as seats. Pending invitations and deactivated
accounts do not. Invitation acceptance, signup and member reactivation check
capacity within the membership transaction, serialized on the workspace row.
Over-limit installations keep their existing users but cannot activate more.

Enterprise licenses remain active for 30 days after their signed expiry, with a
grace warning. After grace, Community remains usable. Removal/re-upload does not
extend the signed expiry. Future-dated or fully expired replacements are rejected
without replacing the existing license.

Licensing never gates login, existing data reads/exports, MFA or enforcement of
existing page restrictions. No user is automatically removed or deactivated.
Offline keys cannot provide immediate revocation, reliable rollback-resistant
time, or protection against an administrator modifying the application.

Existing AGPL and other upstream license/source obligations remain unchanged.
No real issuer key is generated or installed by these tools or tests.
