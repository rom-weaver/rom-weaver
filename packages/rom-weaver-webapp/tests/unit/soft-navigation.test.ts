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
  newTabLink.href = "http://localhost/create";
  newTabLink.target = "_blank";
  document.body.append(newTabLink);
  expect(getSoftNavigationUrl(click(newTabLink), newTabLink, currentUrl)).toBeNull();
});
