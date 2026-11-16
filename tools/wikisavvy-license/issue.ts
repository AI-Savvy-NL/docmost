import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey } from "node:crypto";
import { issueLicense } from "../../packages/wikisavvy-license/src/index";

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: pnpm license:issue --claims claims.json --kid issuer-id --out customer.license",
    );
    console.log(
      "Provide an offline Ed25519 private PEM on standard input. The license is written only to the output file.",
    );
    return;
  }
  if (args.length !== 6) throw new Error();
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--claims", "--kid", "--out"].includes(args[index]) ||
      options.has(args[index]) ||
      !args[index + 1]
    )
      throw new Error();
    options.set(args[index], args[index + 1]);
  }
  if (options.size !== 3 || process.stdin.isTTY) throw new Error();
  const fd = openSync(options.get("--claims")!, "r");
  let claims: any;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error();
    claims = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  const input = Buffer.alloc(65537);
  try {
    let length = 0;
    while (length < input.length) {
      const bytes = readSync(0, input, length, input.length - length, null);
      if (!bytes) break;
      length += bytes;
    }
    if (length > 65536) throw new Error();
    const key = createPrivateKey(input.subarray(0, length));
    const envelope = issueLicense(claims, options.get("--kid")!, key);
    writeFileSync(options.get("--out")!, envelope + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      "WikiSavvy license written to the requested file. No capability is enabled until independently implemented.",
    );
  } finally {
    input.fill(0);
  }
}

try {
  main();
} catch {
  console.error(
    "License issuance failed. Check the claims, issuer identifier, signing key input and output path.",
  );
  process.exitCode = 1;
}
