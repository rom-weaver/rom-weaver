// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ACCENTS } from "../../src/webapp/accent-palette.mjs";

let applyAccent: typeof import("../../src/webapp/accent.ts").applyAccent;
let favicon: HTMLLinkElement;
let touchIcon: HTMLLinkElement;

describe("static favicon with accents", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    ({ applyAccent } = await import("../../src/webapp/accent.ts"));
    favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/x-icon";
    favicon.href = "/favicon.ico";
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

  test.each(ACCENTS)("keeps the favicon for $label", (accent) => {
    applyAccent(accent.value);
    expect(favicon.getAttribute("href")).toBe("/favicon.ico");
    expect(touchIcon.getAttribute("href")).toBe("/apple-touch-icon.png");
  });

  test("keeps the favicon while accents change and invalid values reset", () => {
    applyAccent("woad");
    const initialUrl = favicon.href;
    applyAccent("teal");
    expect(favicon.href).toBe(initialUrl);
    applyAccent("chartreuse");
    expect(favicon.href).toBe(initialUrl);
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  test("applies the accent when the host page has no favicon link", () => {
    favicon.remove();
    expect(() => applyAccent("violet")).not.toThrow();
    expect(document.documentElement.dataset.accent).toBe("violet");
  });
});
