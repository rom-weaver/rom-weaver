import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "../../src/webapp/design-system/index.css";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { HomePage } from "../../src/webapp/components/home-page.tsx";

let host;
let root;

afterEach(() => {
  root?.unmount();
  host?.remove();
});

test("a route card opens its workflow from anywhere on the card", async () => {
  host = document.createElement("div");
  host.className = "rw-app";
  host.style.width = "560px";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { language: "en" } },
      createElement(HomePage, { baseUrl: "https://example.com/" }),
    ),
  );
  await expect.poll(() => host.querySelector(".home-route:not(.home-route-split)")).not.toBeNull();
  const card = host.querySelector(".home-route:not(.home-route-split)");
  const link = card.querySelector(".home-route-go");
  const opened = [];
  link.addEventListener("click", (event) => {
    event.preventDefault();
    opened.push(link.getAttribute("href"));
  });

  // The press lands on the card text, which only the button's card-wide ::after
  // covers. A hover or press transform on the button would make it the
  // containing block of that overlay and shrink it back to the button between
  // mousedown and mouseup, so the click would miss the link.
  const cardBox = card.getBoundingClientRect();
  const body = card.querySelector(".home-route-body").getBoundingClientRect();
  await userEvent.click(card, {
    position: { x: body.left - cardBox.left + 10, y: body.top - cardBox.top + body.height / 2 },
  });
  expect(opened).toEqual(["/apply-rom-patches"]);
});

test("an inline guide link inside a single-action route card opens the guide instead of the card link", async () => {
  host = document.createElement("div");
  host.className = "rw-app";
  host.style.width = "560px";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(
      RomWeaverSettingsProvider,
      { settings: { language: "en" } },
      createElement(HomePage, { baseUrl: "https://example.com/" }),
    ),
  );
  await expect
    .poll(() =>
      host.querySelector('.home-route:not(.home-route-split) .home-route-body a[href="/docs/apply-bps-patch"]'),
    )
    .not.toBeNull();
  const card = host.querySelector(".home-route:not(.home-route-split)");
  const cardLink = card.querySelector(".home-route-go");
  const guideLink = card.querySelector('.home-route-body a[href="/docs/apply-bps-patch"]');
  const opened = [];
  for (const anchor of [cardLink, guideLink]) {
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      opened.push(anchor.getAttribute("href"));
    });
  }
  await userEvent.click(guideLink);
  expect(opened).toEqual(["/docs/apply-bps-patch"]);
});
