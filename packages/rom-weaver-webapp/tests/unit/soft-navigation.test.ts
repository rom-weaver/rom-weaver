// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { getSoftNavigationUrl } from "../../src/webapp/soft-navigation.ts";

const click = (anchor: HTMLAnchorElement, options: MouseEventInit = {}) =>
  new MouseEvent("click", { bubbles: true, button: 0, ...options });

const currentUrl = new URL("http://localhost/docs");

test("accepts same-origin app routes and leaves ordinary links alone", () => {
  const appLink = document.createElement("a");
  appLink.href = "http://localhost/docs/cli#install";
  document.body.append(appLink);
  expect(getSoftNavigationUrl(click(appLink), appLink, currentUrl)?.pathname).toBe("/docs/cli");

  const externalLink = document.createElement("a");
  externalLink.href = "https://example.com/docs/cli";
  document.body.append(externalLink);
  expect(getSoftNavigationUrl(click(externalLink), externalLink, currentUrl)).toBeNull();

  const newTabLink = document.createElement("a");
  newTabLink.href = "http://localhost/create-patch";
  newTabLink.target = "_blank";
  document.body.append(newTabLink);
  expect(getSoftNavigationUrl(click(newTabLink), newTabLink, currentUrl)).toBeNull();
});

test("keeps fragment-only links on the current route despite the app base URL", () => {
  const base = document.createElement("base");
  base.href = `${window.location.origin}/`;
  document.head.append(base);
  const anchor = document.createElement("a");
  anchor.href = "#main-content";
  document.body.append(anchor);
  try {
    const route = new URL("/apply-patches?guide=apply", window.location.origin);
    expect(new URL(anchor.href).pathname).toBe("/");
    expect(getSoftNavigationUrl(click(anchor), anchor, route)?.href).toBe(
      `${window.location.origin}/apply-patches?guide=apply#main-content`,
    );
  } finally {
    anchor.remove();
    base.remove();
  }
});
