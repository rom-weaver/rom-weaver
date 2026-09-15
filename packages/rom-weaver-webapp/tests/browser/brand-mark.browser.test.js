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

test.each(["light", "dark"])("the %s logo image loads without distortion", async (theme) => {
  document.documentElement.dataset.theme = theme;
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(BrandMark));
  await expect.poll(() => host.querySelector(".brand-mark")).not.toBeNull();
  const image = host.querySelector(".brand-mark");
  await expect.poll(() => image?.complete && image.naturalWidth).toBe(192);
  expect(image.naturalHeight).toBe(192);
  expect(image.getBoundingClientRect().width).toBe(image.getBoundingClientRect().height);
  expect(image.getAttribute("alt")).toBe("");
});
