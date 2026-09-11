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
});

test.each(["light", "dark"])("the %s logo has centered contacts and no generic icon outline", async (theme) => {
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(BrandMark));
  await expect.poll(() => host.querySelector(".brand-mark path")).not.toBeNull();

  for (const shape of host.querySelectorAll(".brand-mark path, .brand-mark rect")) {
    expect(getComputedStyle(shape).stroke).toBe("none");
  }

  const cartridge = host.querySelector(".brand-mark > path");
  for (let x = 0.25; x < 32; x += 0.5) {
    expect(cartridge.isPointInFill(new DOMPoint(x, 55))).toBe(cartridge.isPointInFill(new DOMPoint(64 - x, 55)));
  }

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  host.append(icon);
  expect(getComputedStyle(icon).stroke).not.toBe("none");
});
