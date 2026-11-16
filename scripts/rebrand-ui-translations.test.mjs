import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateTranslations } from "./rebrand-ui-translations.mjs";

describe("UI translation branding migration", () => {
  const oldKey = "Connect {{name}} to Docmost";
  const newKey = "Connect {{name}} to {{appName}}";
  it("preserves translations, interpolation and unrelated formatting", () => {
    const input =
      '{\n  "' +
      oldKey +
      '": "Verbind {{name}} met Docmost",\n  "Other": "unchanged"\n}\n';
    const output = migrateTranslations(input);
    assert.equal(
      JSON.parse(output)[newKey],
      "Verbind {{name}} met {{appName}}",
    );
    assert.equal(JSON.parse(output)[oldKey], undefined);
    assert.ok(output.includes('  "Other": "unchanged"\n'));
    assert.equal(migrateTranslations(output), output);
  });
  it("does not rewrite real external-content and inactive EE translation fixtures", () => {
    const input = JSON.stringify(
      { "Link example": "https://docmost.com", "Docmost AI": "Docmost AI" },
      null,
      2,
    );
    assert.equal(migrateTranslations(input), input);
  });
  it("refuses ambiguous new keys and invalid translation input", () => {
    assert.throws(() =>
      migrateTranslations(
        JSON.stringify(
          { [oldKey]: "Docmost", [newKey]: "Existing translation" },
          null,
          2,
        ),
      ),
    );
    assert.throws(() =>
      migrateTranslations(JSON.stringify({ [oldKey]: 123 }, null, 2)),
    );
    assert.throws(() => migrateTranslations("not-json"));
  });
});
