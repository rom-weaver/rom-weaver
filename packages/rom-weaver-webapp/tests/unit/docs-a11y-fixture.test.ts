import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createDocRoute } from "../../src/webapp/docs-content.mjs";
import { DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";

/** Every element name and `docs-*` class a rendered page uses. */
const readShapes = (html: string) => {
  const shapes = new Set<string>();
  for (const tag of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    shapes.add(`<${tag[1].toLowerCase()}>`);
    for (const value of tag[2].matchAll(/\bclass="([^"]*)"/g)) {
      for (const name of value[1].split(/\s+/)) if (name.startsWith("docs-")) shapes.add(`.${name}`);
    }
    for (const attribute of tag[2].matchAll(/\b(role|data-docs-screenshot-theme)="([^"]*)"/g)) {
      shapes.add(`[${attribute[1]}=${attribute[2]}]`);
    }
  }
  return shapes;
};

const fixtureRoute = () =>
  createDocRoute(
    { file: "../fixtures/docs-a11y-fixture.md", label: "Fixture", slug: "docs/a11y-fixture" },
    fs.readFileSync(new URL("../fixtures/docs-a11y-fixture.md", import.meta.url), "utf8"),
  );

describe("docs accessibility fixture", () => {
  // The browser accessibility test scans only this page, so a guide that starts using an
  // element the fixture lacks would otherwise reach readers unscanned.
  it("uses every element and docs class that a published guide renders", () => {
    const fixture = readShapes(fixtureRoute().html);
    const missing = new Map<string, string>();
    for (const route of DOC_ROUTES) {
      for (const shape of readShapes(route.html)) if (!fixture.has(shape)) missing.set(shape, route.slug);
    }
    expect(
      [...missing].map(([shape, slug]) => `${shape} (first seen on ${slug})`),
      "add each of these to tests/fixtures/docs-a11y-fixture.md",
    ).toEqual([]);
  });
});
