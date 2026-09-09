import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCatalogVersion,
  isCatalogLoaded,
  loadCatalog,
  MESSAGE_CATALOGS,
  subscribeCatalogs,
} from "../../src/presentation/localization/catalog.ts";
import { createLocalizer, LOCALE_OPTIONS, preloadCatalog } from "../../src/presentation/localization/index.ts";

/**
 * Only English ships in the main bundle. This file never preloads, so it sees
 * the state a visitor's first render sees: a lazy locale answers in English
 * until its chunk lands, then the same localizer reads the translation.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lazy catalogs", () => {
  it("bundles only English up front and still offers every shipped locale", () => {
    expect(Object.keys(MESSAGE_CATALOGS)).toEqual(["en"]);
    expect(LOCALE_OPTIONS.map((option) => option.value)).toEqual(["en", "de", "es"]);
    expect(isCatalogLoaded("de")).toBe(false);
  });

  it("falls back to English until the locale's chunk lands, then translates in place", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCatalogs(listener);
    const versionBefore = getCatalogVersion();
    const de = createLocalizer("de");
    expect(de.locale).toBe("de");
    expect(de.message("ui.step.apply")).toBe("Apply");

    await loadCatalog("de");
    expect(isCatalogLoaded("de")).toBe(true);
    expect(getCatalogVersion()).toBe(versionBefore + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(de.message("ui.step.apply")).toBe("Anwenden");
    expect(createLocalizer("de-AT").message("ui.step.apply")).toBe("Anwenden");
    unsubscribe();
  });

  it("preloads the catalog a locale resolves to and tolerates unknown locales", async () => {
    vi.stubGlobal("navigator", { languages: ["es-MX", "en"] });
    await preloadCatalog();
    expect(isCatalogLoaded("es")).toBe(true);
    expect(createLocalizer("es").message("ui.step.apply")).toBe("Aplicar");
    await expect(preloadCatalog("xx")).resolves.toBeUndefined();
    await expect(loadCatalog("xx")).rejects.toThrow('No message catalog ships for locale "xx"');
  });
});
