import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { BrandMark } from "../../src/webapp/components/brand-mark.tsx";
import "../../src/webapp/design-system/index.css";

let host;
let root;

afterEach(() => {
  root?.unmount();
  host?.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-accent");
});

test.each(["light", "dark"])("the %s logo has no square background", async (theme) => {
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(BrandMark));
  await expect.poll(() => host.querySelector(".brand-mark-accent")).not.toBeNull();
  const mark = host.querySelector(".brand-mark");
  expect(mark.tagName.toLowerCase()).toBe("svg");
  expect(mark.getBoundingClientRect().width).toBe(mark.getBoundingClientRect().height);
  expect([...mark.querySelectorAll("rect")].every((rect) => rect.hasAttribute("mask"))).toBe(true);
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  const cartridge = mark.querySelector("rect");
  expect(getComputedStyle(cartridge).fill).toBe(theme === "light" ? "rgb(32, 40, 45)" : "rgb(246, 236, 218)");
});

test.each(["woad", "teal"])("the light logo W follows the %s accent", async (accent) => {
  document.documentElement.dataset.theme = "light";
  document.documentElement.dataset.accent = accent;
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(BrandMark));
  await expect.poll(() => host.querySelector(".brand-mark-accent")).not.toBeNull();
  const w = host.querySelector(".brand-mark-accent");
  const expected = document.createElement("span");
  expected.style.color = "var(--thread)";
  host.append(expected);
  expect(getComputedStyle(w).fill).toBe(getComputedStyle(expected).color);
});
