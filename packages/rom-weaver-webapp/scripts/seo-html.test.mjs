import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";
import { createSitemapSource, createWorkflowRouteHtml, injectLdJson } from "./vite-config/seo-html.mjs";

const routeShell = `<!doctype html><html><head>
<title>old</title>
<meta name="description" content="old">
<meta property="og:title" content="old">
<meta property="og:description" content="old">
<meta property="og:url" content="old">
<meta name="twitter:title" content="old">
<meta name="twitter:description" content="old">
<link rel="canonical" href="old">
</head><body></body></html>`;

test("workflow descriptions propagate to metadata and structured data", () => {
  for (const key of ["home", "identify", "patcher", "creator"]) {
    const route = WORKFLOW_SEO_ROUTES[key];
    const html = injectLdJson(createWorkflowRouteHtml(routeShell, route, "prod", "Production"), route, key === "home");
    const expectedCanonical = `https://rom-weaver.com/${route.slug}`;

    assert.ok(html.includes(`<meta name="description" content="${route.description}">`), `${key} description`);
    assert.ok(html.includes(`<meta property="og:description" content="${route.description}">`), `${key} Open Graph`);
    assert.ok(html.includes(`<meta name="twitter:description" content="${route.description}">`), `${key} Twitter`);
    assert.ok(html.includes(`<link rel="canonical" href="${expectedCanonical}">`), `${key} canonical`);

    const ldJson = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1];
    assert.ok(ldJson, `${key} JSON-LD`);
    const application = JSON.parse(ldJson)["@graph"].find((entry) => entry["@type"] === "SoftwareApplication");
    assert.equal(application.description, route.description, `${key} JSON-LD description`);
    assert.equal(application.url, expectedCanonical, `${key} JSON-LD URL`);
  }
});

test("public workflow descriptions advertise standard cheat capabilities", () => {
  assert.ok(WORKFLOW_SEO_ROUTES.patcher.description.includes("Add supported cheat codes"));
  assert.ok(WORKFLOW_SEO_ROUTES.creator.description.includes("from modified ROMs or supported cheat codes"));
  assert.ok(WORKFLOW_SEO_ROUTES.identify.description.includes("inspect known cheat codes"));
  for (const route of Object.values(WORKFLOW_SEO_ROUTES)) {
    assert.ok(!route.description.toLocaleLowerCase().includes("beta"), route.slug || "home");
  }
});

test("the sitemap includes the public compression workflow", () => {
  const sitemap = createSitemapSource();
  assert.ok(sitemap.includes("<loc>https://rom-weaver.com/compress</loc>"));
});

test("the sitemap contains each indexable workflow once and excludes beta tools", () => {
  const locations = [...createSitemapSource().matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  assert.equal(locations.length, new Set(locations).size);
  for (const slug of [
    "apply-patches",
    "bundle-patches",
    "checksum",
    "create-patch",
    "extract",
    "identify-rom",
    "test-rom",
  ]) {
    assert.ok(locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
  for (const slug of ["trim", "ppf-undo", "save-editor"]) {
    assert.ok(!locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
});
