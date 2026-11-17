/**
 * Axe scan of one page that uses every element a published guide can contain
 * (tests/fixtures/docs-a11y-fixture.md), in both themes and across phone, tablet,
 * and desktop widths. The guides share one shell and one stylesheet, so scanning each
 * of them repeats this page; tests/unit/docs-a11y-fixture.test.ts fails when a guide
 * uses an element the fixture lacks.
 */

import axeModule from "axe-core";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { page } from "vitest/browser";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import fixtureMarkdown from "../fixtures/docs-a11y-fixture.md?raw";
// The real design system, so axe and getComputedStyle see production colours.
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";
import "../../src/webapp/design-system/docs-route.css";

const axe = axeModule.default ?? axeModule;
const THEMES = ["light", "dark"];
const VIEWPORTS = [
  { height: 740, name: "360w smallest phone", width: 360 },
  { height: 1024, name: "768w portrait tablet", width: 768 },
  { height: 900, name: "1280w desktop", width: 1280 },
];
const DEFAULT_VIEWPORT = { height: 900, width: 1280 };
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];

const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

// Settled colours: a mid-fade frame would read as a contrast failure.
beforeAll(() => {
  const noMotion = document.createElement("style");
  noMotion.textContent =
    "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;}";
  document.head.appendChild(noMotion);
});

afterEach(async () => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

/** Mount the fixture inside the same wrappers the docs page renders. */
const mountFixture = () => {
  const route = createDocRoute(
    { file: "../fixtures/docs-a11y-fixture.md", label: "Fixture", slug: "docs/a11y-fixture" },
    fixtureMarkdown,
  );
  const app = document.createElement("div");
  app.className = "rw-app";
  app.innerHTML = [
    '<main class="docs-workbench" id="main">',
    '<div class="docs-layout docs-layout-full"><section class="docs-panel">',
    '<article class="docs-article"><div class="docs-markdown" data-docs-markdown></div></article>',
    "</section></div></main>",
  ].join("");
  app.querySelector("[data-docs-markdown]").innerHTML = route.html;
  // Axe skips the content of a closed <details>.
  for (const details of app.querySelectorAll("details")) details.open = true;
  document.body.replaceChildren(app);
  return app;
};

const violationsIn = async (context) => {
  const results = await axe.run(context, {
    resultTypes: ["violations"],
    rules: { region: { enabled: false } },
    runOnly: { type: "tag", values: TAGS },
  });
  return results.violations.map((violation) => {
    const sample = violation.nodes[0]?.any?.[0]?.data ?? violation.nodes[0]?.all?.[0]?.data;
    const detail =
      sample && sample.contrastRatio !== undefined
        ? ` [ratio ${sample.contrastRatio} need ${sample.expectedContrastRatio}, fg ${sample.fgColor} on ${sample.bgColor}]`
        : "";
    return `${violation.id} (${violation.impact}): ${violation.help}${detail} - ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`;
  });
};

describe("docs accessibility fixture", () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`passes WCAG 2.2 A/AA (${theme} theme, ${viewport.name})`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        const app = mountFixture();
        await settle();
        // A scan of an empty or half-rendered page passes; prove the page is there.
        expect(app.querySelectorAll(".docs-article h1")).toHaveLength(1);
        expect(app.querySelector(".docs-table-scroll table")).not.toBeNull();
        expect(app.querySelector("pre code")).not.toBeNull();
        expect(await violationsIn(app)).toEqual([]);
      });
    }
  }
});
