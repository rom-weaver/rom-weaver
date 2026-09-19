// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCENTS } from "../../src/webapp/accent-palette.mjs";
import { BRAND_MARK_FAVICON_VIEWBOX } from "../../src/webapp/brand-mark-assets.mjs";

let applyAccent: typeof import("../../src/webapp/accent.ts").applyAccent;
let favicon: HTMLLinkElement;
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
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.dataset.favicon = "";
    favicon.href = "/favicon.svg";
    touchIcon = document.createElement("link");
    touchIcon.rel = "apple-touch-icon";
    touchIcon.href = "/apple-touch-icon.png";
    document.head.append(favicon, touchIcon);
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    favicon.remove();
    touchIcon.remove();
    document.documentElement.classList.remove("accent-anim");
    document.documentElement.removeAttribute("data-accent");
  });

  test.each(ACCENTS)("applies $label to the favicon on initial load", (accent) => {
    applyAccent(accent.value);
    const svg = readFavicon(favicon).documentElement;
    expect(svg.querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe(accent.swatch);
    expect(svg.getAttribute("viewBox")).toBe(BRAND_MARK_FAVICON_VIEWBOX);
    expect(svg.getAttribute("width")).toBe("64");
    expect(svg.getAttribute("height")).toBe("64");
    expect(svg.getAttribute("preserveAspectRatio")).toBeNull();
    expect(svg.querySelector(".brand-mark-cartridge")?.getAttribute("fill")).toBe("var(--brand-cartridge)");
    expect(svg.querySelector("style")?.textContent).toContain("@media (prefers-color-scheme: dark)");
    expect(touchIcon.getAttribute("href")).toBe("/apple-touch-icon.png");
  });

  test("changes the favicon immediately and restores madder for invalid values", () => {
    applyAccent("woad");
    const initialUrl = favicon.href;
    applyAccent("teal");
    expect(favicon.href).not.toBe(initialUrl);
    expect(readFavicon(favicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#009ba5");
    applyAccent("chartreuse");
    expect(readFavicon(favicon).querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#e87208");
  });

  test("applies the accent when the host page has no favicon link", () => {
    favicon.remove();
    expect(() => applyAccent("violet")).not.toThrow();
    expect(document.documentElement.dataset.accent).toBe("violet");
  });
});
