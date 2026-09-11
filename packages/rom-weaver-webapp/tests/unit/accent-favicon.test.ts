// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCENTS } from "../../src/webapp/accent-palette.mjs";

let applyAccent: typeof import("../../src/webapp/accent.ts").applyAccent;
let favicon: HTMLLinkElement;
let touchIcon: HTMLLinkElement;

const readFavicon = () => {
  const prefix = "data:image/svg+xml,";
  const href = favicon.getAttribute("href") ?? "";
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
    favicon.href = "/logo.svg";
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
    expect(readFavicon().querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe(accent.swatch);
    expect(touchIcon.getAttribute("href")).toBe("/apple-touch-icon.png");
  });

  test("changes the favicon immediately and restores madder for invalid values", () => {
    applyAccent("woad");
    const initialUrl = favicon.href;
    applyAccent("teal");
    expect(favicon.href).not.toBe(initialUrl);
    expect(readFavicon().querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#2aa0a8");
    applyAccent("chartreuse");
    expect(readFavicon().querySelector(".brand-mark-accent")?.getAttribute("fill")).toBe("#d9690f");
  });

  test("applies the accent when the host page has no favicon link", () => {
    favicon.remove();
    expect(() => applyAccent("violet")).not.toThrow();
    expect(document.documentElement.dataset.accent).toBe("violet");
  });
});
