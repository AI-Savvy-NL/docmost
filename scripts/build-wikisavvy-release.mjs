import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseMetadata(revision, now = new Date()) {
  if (!/^[0-9a-f]{40}$/.test(revision) || !Number.isFinite(now.getTime())) {
    throw new Error(
      "A full committed revision and valid build date are required",
    );
  }
  const date = now.toISOString().slice(0, 10);
  const version = `${date.replaceAll("-", ".")}-${revision.slice(0, 8)}`;
  return { revision, date, version, image: `wikisavvy:${version}` };
}

export function dockerBuildArguments(metadata, context) {
  return [
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `WIKISAVVY_BUILD_REVISION=${metadata.revision}`,
    "--build-arg",
    `WIKISAVVY_BUILD_DATE=${metadata.date}`,
    "--tag",
    metadata.image,
    context,
  ];
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    timeout: 30000,
    ...options,
  });
  if (result.status !== 0)
    throw new Error("Cannot prepare committed release source");
  return result.stdout?.trim();
}

function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/build-wikisavvy-release.mjs");
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("Release builds require a clean committed working tree");
  }
  const metadata = releaseMetadata(git(["rev-parse", "HEAD"]));
  const directory = mkdtempSync(join(tmpdir(), "wikisavvy-release-"));
  const context = join(directory, "source");
  mkdirSync(context);
  const archive = join(directory, "source.tar");
  const fd = openSync(archive, "wx", 0o600);
  try {
    git(["archive", "--format=tar", metadata.revision], {
      stdio: ["ignore", fd, "pipe"],
    });
  } finally {
    closeSync(fd);
  }
  const unpacked = spawnSync("tar", ["-xf", archive, "-C", context], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (unpacked.status !== 0)
    throw new Error("Cannot unpack committed release source");
  const result = spawnSync("docker", dockerBuildArguments(metadata, context), {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Release image build failed");
  console.log(JSON.stringify({ ...metadata, sourceDirectory: context }));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
