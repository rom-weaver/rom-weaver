// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCENTS } from "../../src/webapp/accent-palette.mjs";

let applyAccent: typeof import("../../src/webapp/accent.ts").applyAccent;
let lightFavicon: HTMLLinkElement;
let darkFavicon: HTMLLinkElement;
let touchIcon: HTMLLinkElement;

const readFavicon = (link: HTMLLinkElement) => {
  const prefix = "data:image/svg+xml,";
  const href = link.getAttribute("href") ?? "";
  expect(href.startsWith(prefix)).toBe(true);
  return new DOMParser().parseFromString(decodeURIComponent(href.slice(prefix.length)), "image/svg+xml");
};

describe("accent favicon", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ applyAccent } = await import("../../src/webapp/accent.ts"));
    lightFavicon = document.createElement("link");
    lightFavicon.rel = "icon";
    lightFavicon.type = "image/svg+xml";
    lightFavicon.dataset.faviconScheme = "light";
    lightFavicon.href = "/favicon.svg";
    darkFavicon = document.createElement("link");
    darkFavicon.rel = "icon";
    darkFavicon.type = "image/svg+xml";
    darkFavicon.dataset.faviconScheme = "dark";
    darkFavicon.href = "/favicon-dark.svg";
    touchIcon = document.createElement("link");
    touchIcon.rel = "apple-touch-icon";
    touchIcon.href = "/apple-touch-icon.png";
    document.head.append(lightFavicon, darkFavicon, touchIcon);
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    lightFavicon.remove();
    darkFavicon.remove();
    touchIcon.remove();
    document.documentElement.classList.remove("accent-anim");
    document.documentElement.removeAttribute("data-accent");
  });

  test.each(ACCENTS)("applies $label to the favicon on initial load", (accent) => {
    applyAccent(accent.value);
    for (const favicon of [lightFavicon, darkFavicon]) {
      expect(readFavicon(favicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe(accent.swatch);
    }
    expect(readFavicon(lightFavicon).querySelector(".brand-mark-cartridge")?.getAttribute("fill")).toBe("#20282d");
    expect(readFavicon(darkFavicon).querySelector(".brand-mark-cartridge")?.getAttribute("fill")).toBe("#f6ecda");
    expect(touchIcon.getAttribute("href")).toBe("/apple-touch-icon.png");
  });

  test("changes the favicon immediately and restores madder for invalid values", () => {
    applyAccent("woad");
    const initialLightUrl = lightFavicon.href;
    const initialDarkUrl = darkFavicon.href;
    applyAccent("teal");
    expect(lightFavicon.href).not.toBe(initialLightUrl);
    expect(darkFavicon.href).not.toBe(initialDarkUrl);
    expect(readFavicon(lightFavicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#009ba5");
    expect(readFavicon(darkFavicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#009ba5");
    applyAccent("chartreuse");
    expect(readFavicon(lightFavicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#e87208");
    expect(readFavicon(darkFavicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#e87208");
  });

  test("applies the accent when the host page has no favicon link", () => {
    lightFavicon.remove();
    darkFavicon.remove();
    expect(() => applyAccent("violet")).not.toThrow();
    expect(document.documentElement.dataset.accent).toBe("violet");
  });
});
