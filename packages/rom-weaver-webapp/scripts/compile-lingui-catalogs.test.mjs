import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { minifySync } from "vite";
import { packCatalogFiles, packCompiledCatalog } from "./compile-lingui-catalogs.mjs";

const compiledSource = (messages) =>
  `import type{Messages}from"@lingui/core";export const messages=JSON.parse(${JSON.stringify(JSON.stringify(messages))}) as Messages;`;

const withCatalogDirectory = async (run) => {
  const directory = mkdtempSync(path.join(tmpdir(), "lingui-catalogs-"));
  try {
    await run(directory, path.join(directory, "{locale}"));
  } finally {
    rmSync(directory, { recursive: true });
  }
};

test("keeps English unchanged and reconstructs exact compiled values in de and es", async () => {
  await withCatalogDirectory(async (directory, template) => {
    const english = {
      "ui.empty": [""],
      "ui.escaped": ['A "quote", a backslash \\, and a line\nbreak'],
      "ui.icu": ["Show ", ["count"], " more ", ["count", "plural", { one: ["item"], other: ["items"] }]],
    };
    const german = {
      "ui.empty": [""],
      "ui.escaped": ['Ein "Zitat", ein Backslash \\, und ein Zeilen\numbruch'],
      "ui.icu": ["Zeige ", ["count"], " weitere ", ["count", "plural", { one: ["Eintrag"], other: ["Einträge"] }]],
    };
    const spanish = {
      "ui.empty": [""],
      "ui.escaped": ['Una "cita", una barra \\, y un salto\nde línea'],
      "ui.icu": ["Mostrar ", ["count"], " más ", ["count", "plural", { one: ["elemento"], other: ["elementos"] }]],
    };
    const catalogs = { en: english, de: german, es: spanish };
    for (const messages of Object.values(catalogs)) {
      messages["ui.select"] = ["value", "select", JSON.parse('{"__proto__":["Match"],"other":["Other"]}')];
    }
    for (const [locale, messages] of Object.entries(catalogs)) {
      writeFileSync(path.join(directory, `${locale}.ts`), compiledSource(messages));
    }
    const originalEnglish = readFileSync(path.join(directory, "en.ts"), "utf8");

    packCatalogFiles(template, ["en", "de", "es"], "en");

    assert.equal(readFileSync(path.join(directory, "en.ts"), "utf8"), originalEnglish);
    for (const locale of ["de", "es"]) {
      const generated = readFileSync(path.join(directory, `${locale}.ts`), "utf8");
      assert.match(generated, /from"\.\/en\.ts"/u);
      const loaded = await import(pathToFileURL(path.join(directory, `${locale}.ts`)).href);
      assert.deepEqual(loaded.messages, catalogs[locale]);
    }
  });
});

test("keeps a mismatched or malformed locale in Lingui's original form", async () => {
  const english = compiledSource({ "ui.one": ["One"], "ui.two": ["Two"] });
  const missing = compiledSource({ "ui.one": ["Eins"] });
  const extra = compiledSource({ "ui.one": ["Eins"], "ui.two": ["Zwei"], "ui.three": ["Drei"] });
  assert.equal(packCompiledCatalog(english, missing, "en"), null);
  assert.equal(packCompiledCatalog(english, extra, "en"), null);
  assert.equal(packCompiledCatalog(english, "invalid TypeScript", "en"), null);

  await withCatalogDirectory(async (directory, template) => {
    writeFileSync(path.join(directory, "en.ts"), english);
    writeFileSync(path.join(directory, "de.ts"), missing);
    const warn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(message);
    try {
      packCatalogFiles(template, ["en", "de"], "en");
    } finally {
      console.warn = warn;
    }
    assert.equal(readFileSync(path.join(directory, "de.ts"), "utf8"), missing);
    assert.match(warnings[0], /kept unmodified/u);
  });
});

test("packed catalogs remain valid modules and save more than the JavaScript budget gap", async () => {
  const keys = Array.from({ length: 726 }, (_, index) => `ui.example.longMessage${index}`);
  const english = compiledSource(Object.fromEntries(keys.map((key) => [key, ["English text"]])));
  const translated = compiledSource(Object.fromEntries(keys.map((key) => [key, ["Translated text"]])));
  const packed = packCompiledCatalog(english, translated, "en");
  assert.ok(packed);
  const originalMinified = minifySync("de.ts", translated);
  const packedMinified = minifySync("de.ts", packed);
  assert.deepEqual(originalMinified.errors, []);
  assert.deepEqual(packedMinified.errors, []);
  assert.ok(Buffer.byteLength(originalMinified.code) - Buffer.byteLength(packedMinified.code) > 7000);
});
