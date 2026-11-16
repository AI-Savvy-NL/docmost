import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const messages = [
  "Connect {{name}} to Docmost",
  "The account you signed in with does not use your Docmost email address. Sign in to the provider with the account that matches your Docmost email and try again.",
  "The Slack account you signed in with is not in the Slack workspace connected to Docmost. Sign in to Slack with your account in that workspace and try again.",
  "Link your Slack account to your Docmost account to:",
  "Search and open Docmost pages from Slack",
  "Create pages and save Slack messages to Docmost",
  "Get your Docmost notifications as Slack DMs",
  "See previews of Docmost links in Slack and Slack links in Docmost",
  "You will sign in with Slack to confirm which Slack account is yours. It must use the same email as your Docmost account.",
  "This Slack workspace is already connected to another Docmost workspace. Disconnect it there first, or install Docmost into a different Slack workspace.",
];

function variables(value) {
  return [
    ...new Set(
      [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) =>
        match[1].trim(),
      ),
    ),
  ].sort();
}

export function migrateTranslations(content) {
  const translations = JSON.parse(content);
  const lines = content.split("\n");
  for (const oldKey of messages) {
    if (!Object.hasOwn(translations, oldKey)) continue;
    const newKey = oldKey.replaceAll("Docmost", "{{appName}}");
    if (Object.hasOwn(translations, newKey))
      throw new Error("Conflicting translation keys");
    const value = translations[oldKey];
    if (typeof value !== "string")
      throw new Error("Expected a string translation");
    const branded = value ? value.replace(/Docmost/gi, "{{appName}}") : newKey;
    if (!branded.includes("{{appName}}"))
      throw new Error("Translated brand needs explicit review");
    if (
      value &&
      JSON.stringify(
        variables(branded).filter((name) => name !== "appName"),
      ) !== JSON.stringify(variables(value))
    ) {
      throw new Error("Translation interpolation changed");
    }
    const prefix = JSON.stringify(oldKey) + ":";
    const matches = lines.flatMap((line, index) =>
      line.trimStart().startsWith(prefix) ? [index] : [],
    );
    if (matches.length !== 1)
      throw new Error("Expected one single-line translation entry");
    const index = matches[0];
    const line = lines[index];
    const indent = line.match(/^\s*/)[0];
    lines[index] =
      indent +
      JSON.stringify(newKey) +
      ": " +
      JSON.stringify(branded) +
      (line.trimEnd().endsWith(",") ? "," : "") +
      (line.endsWith("\r") ? "\r" : "");
    delete translations[oldKey];
    translations[newKey] = branded;
  }
  const result = lines.join("\n");
  const actual = JSON.parse(result);
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(translations).sort())
  ) {
    throw new Error("Unexpected translation changes");
  }
  return result;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "--check";
  if (!["--check", "--write"].includes(mode) || process.argv.length > 3)
    throw new Error("Use --check or --write");
  const directory = resolve(
    import.meta.dirname,
    "../apps/client/public/locales",
  );
  const changes = readdirSync(directory)
    .map((locale) => {
      const path = resolve(directory, locale, "translation.json");
      const before = readFileSync(path, "utf8");
      return { path, before, after: migrateTranslations(before) };
    })
    .filter(({ before, after }) => before !== after);
  if (mode === "--write") {
    for (const { path, after } of changes) writeFileSync(path, after);
  }
  console.log(
    `${changes.length} locale files ${mode === "--write" ? "updated" : "need migration"}`,
  );
  if (mode === "--check" && changes.length) process.exitCode = 1;
}
