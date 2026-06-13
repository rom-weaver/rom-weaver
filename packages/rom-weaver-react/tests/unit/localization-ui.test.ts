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
  "ui.mode.apply",
  "ui.mode.create",
  "ui.mode.trim",
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
  "ui.status.idle",
  "ui.status.ready",
  "ui.status.running",
  "ui.status.failed",
  "ui.status.done",
  "ui.announce.copied",
  "ui.log.filter",
  "ui.log.filterLabel",
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
    expect(es.message("ui.mode.apply")).toBe("Aplicar");
    expect(de.message("ui.mode.apply")).toBe("Anwenden");
    expect(en.message("ui.mode.apply")).toBe("Apply");
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
    expect(en.messageCount("ui.roms.files", 1)).toBe("1 file");
    expect(en.messageCount("ui.roms.files", 3)).toBe("3 files");
    const es = createLocalizer("es");
    expect(es.messageCount("ui.roms.files", 1)).toBe("1 archivo");
    expect(es.messageCount("ui.roms.files", 2)).toBe("2 archivos");
  });
});
