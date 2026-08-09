import { describe, expect, it } from "vitest";
import { MESSAGE_CATALOGS } from "../../src/presentation/localization/catalog.ts";
import { createLocalizer, LOCALE_OPTIONS } from "../../src/presentation/localization/index.ts";
import { SETTINGS_FIELD_METADATA } from "../../src/webapp/settings/settings-metadata.ts";

/**
 * Loom UI catalog contract: the chrome reads `ui.*` ids through
 * useUiLocalizer, so missing ids would leak raw keys (or dev placeholders)
 * into the masthead/steps. Pins the plural helper and the per-id English
 * fallback for partial locales.
 */

const LOAD_BEARING_UI_IDS = [
  "ui.theme.toLight",
  "ui.theme.toDark",
  "ui.tools.log",
  "ui.tools.more",
  "ui.settings.title",
  "ui.common.copy",
  "ui.common.close",
  "ui.common.dismiss",
  "ui.update.ready",
  "ui.update.reload",
  "ui.drop.release",
  "ui.footer.donate",
  "ui.env.threads",
  "ui.log.filter",
  "ui.log.filterLabel",
  "ui.step.apply",
  "ui.bundleExport.shareDescription",
  "ui.bundleExport.shareTitle",
] as const;

describe("ui catalog", () => {
  it("covers the load-bearing chrome ids in every shipped locale", () => {
    for (const locale of ["en", "es", "de"]) {
      const catalog = MESSAGE_CATALOGS[locale];
      expect(catalog, locale).toBeTruthy();
      for (const id of LOAD_BEARING_UI_IDS) {
        expect(catalog?.[id], `${locale} ${id}`).toBeTruthy();
      }
    }
  });

  it("translates the chrome for es/de instead of echoing English", () => {
    const en = createLocalizer("en");
    const es = createLocalizer("es");
    const de = createLocalizer("de");
    expect(es.message("ui.common.copy")).toBe("Copiar");
    expect(de.message("ui.common.copy")).toBe("Kopieren");
    expect(en.message("ui.common.copy")).toBe("Copy");
    expect(es.message("ui.step.apply")).toBe("Aplicar");
    expect(de.message("ui.step.apply")).toBe("Anwenden");
    expect(en.message("ui.step.apply")).toBe("Apply");
    expect(es.message("ui.bundleExport.shareTitle")).toBe("Comparte esta configuración");
    expect(de.message("ui.bundleExport.shareTitle")).toBe("Diese Konfiguration teilen");
  });

  it("falls back to English per-id for unknown ids in a partial locale", () => {
    const es = createLocalizer("es");
    // settings.* labels exist in en; a hypothetical untranslated id must not
    // surface the raw key in production catalogs that do have the en entry.
    expect(es.message("settings.language")).toBe("Idioma");
  });
});

describe("messageCount", () => {
  it("selects plural categories per locale", () => {
    const en = createLocalizer("en");
    expect(en.messageCount("ui.patch.offCount", 1)).toBe("1 patch is off - tick it to include it");
    expect(en.messageCount("ui.patch.offCount", 3)).toBe("3 patches are off - tick them to include them");
    const es = createLocalizer("es");
    // Spanish selects a distinct plural form and translates instead of echoing English.
    expect(es.messageCount("ui.patch.offCount", 1)).toMatch(/^1 parche está/);
    expect(es.messageCount("ui.patch.offCount", 2)).toMatch(/^2 parches están/);
  });
});

describe("LOCALE_OPTIONS", () => {
  it("offers exactly the locales that ship a catalog", () => {
    // A locale without a catalog would render English under another name, so
    // the picker's list is derived from the catalogs rather than curated.
    expect(LOCALE_OPTIONS.map((locale) => locale.value).sort()).toEqual(Object.keys(MESSAGE_CATALOGS).sort());
  });

  it("leads with the default locale and names each language in its own words", () => {
    expect(LOCALE_OPTIONS[0]?.value).toBe("en");
    expect(LOCALE_OPTIONS.map((locale) => locale.label)).toEqual(["English", "Deutsch", "Español"]);
  });

  it("is the settings language field's option list", () => {
    expect(SETTINGS_FIELD_METADATA.language.options).toEqual([...LOCALE_OPTIONS]);
  });
});
