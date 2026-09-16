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
  expect(mark.querySelector("rect")).toBeNull();
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  const cartridge = mark.querySelector("g");
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

const paintedPixel = async (mark, x, y) => {
  const clone = mark.cloneNode(true);
  const originals = mark.querySelectorAll("g");
  clone.querySelectorAll("g").forEach((group, index) => {
    group.setAttribute("fill", getComputedStyle(originals[index]).fill);
  });
  const image = new Image();
  image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 1254;
  canvas.height = 1254;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, 1254, 1254);
  return [...context.getImageData(x, y, 1, 1).data];
};

test.each(["light", "dark"])("the %s logo paints the supplied RW cartridge", async (theme) => {
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(BrandMark));
  await expect.poll(() => host.querySelector(".brand-mark-accent")).not.toBeNull();
  const mark = host.querySelector(".brand-mark");
  const cartridge = theme === "light" ? [32, 40, 45, 255] : [246, 236, 218, 255];
  const r = theme === "light" ? [238, 242, 247, 255] : [32, 40, 45, 255];
  expect(await paintedPixel(mark, 150, 500)).toEqual(cartridge);
  expect(await paintedPixel(mark, 280, 500)).toEqual(r);
  expect((await paintedPixel(mark, 850, 500))[3]).toBe(255);
  expect((await paintedPixel(mark, 20, 20))[3]).toBe(0);
  expect((await paintedPixel(mark, 550, 150))[3]).toBe(0);
  expect((await paintedPixel(mark, 370, 1050))[3]).toBe(0);
});
