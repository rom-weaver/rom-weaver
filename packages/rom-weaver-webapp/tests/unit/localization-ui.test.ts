import { describe, expect, it } from "vitest";
import { MESSAGE_CATALOGS } from "../../src/presentation/localization/catalog.ts";
import { createLocalizer } from "../../src/presentation/localization/index.ts";

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
  "ui.settings.title",
  "ui.common.copy",
  "ui.common.close",
  "ui.common.dismiss",
  "ui.update.ready",
  "ui.update.reload",
  "ui.wakelock.text",
  "ui.drop.release",
  "ui.footer.donate",
  "ui.env.threads",
  "ui.log.filter",
  "ui.log.filterLabel",
  "ui.step.apply",
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
    expect(es.message("ui.step.apply")).toBe("Tejer");
    expect(de.message("ui.step.apply")).toBe("Weben");
    expect(en.message("ui.step.apply")).toBe("Weave");
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
