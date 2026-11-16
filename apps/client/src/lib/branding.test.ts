import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAppName } from "./config.ts";

const indexHtml = readFileSync(
  resolve(import.meta.dirname, "../../index.html"),
  "utf8",
);
const manifest = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../public/manifest.json"),
    "utf8",
  ),
);

describe("App branding", () => {
  it("uses WikiSavvy as the app name", () => {
    expect(getAppName()).toBe("WikiSavvy");
  });

  it("matches the initial browser title to the app name", () => {
    const document = new DOMParser().parseFromString(indexHtml, "text/html");
    expect(document.title).toBe(getAppName());
  });

  it("matches the installed Apple app name to the app name", () => {
    const document = new DOMParser().parseFromString(indexHtml, "text/html");
    expect(
      document
        .querySelector('meta[name="apple-mobile-web-app-title"]')
        ?.getAttribute("content"),
    ).toBe(getAppName());
  });

  it("matches both installed app names to the app name", () => {
    expect(manifest.name).toBe(getAppName());
    expect(manifest.short_name).toBe(getAppName());
  });
});
