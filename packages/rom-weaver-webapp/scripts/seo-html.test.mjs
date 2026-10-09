import assert from "node:assert/strict";
import { test } from "node:test";
import { MARKDOWN_ROUTES } from "../functions/markdown-routes.js";
import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import { WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";
import {
  createRobotsSource,
  createSitemapSource,
  createWorkflowRouteHtml,
  createWorkflowMarkdown,
  injectLdJson,
} from "./vite-config/seo-html.mjs";

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
  for (const key of ["home", "identify", "patcher", "creator", "ppf-undo"]) {
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
    "weave-patches",
    "checksum",
    "create-patch",
    "extract",
    "identify-rom",
    "ppf-undo",
    "test-rom",
  ]) {
    assert.ok(locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
  for (const slug of ["trim-rom", "save-editor"]) {
    assert.ok(!locations.includes(`https://rom-weaver.com/${slug}`), slug);
  }
});

for (const channel of ["prod", "beta", "nightly", "preview", "dev"]) {
  test(`${channel} robots declares content usage and crawl policy`, () => {
    const robots = createRobotsSource(channel);
    const signal = channel === "prod" ? "yes" : "no";
    assert.ok(
      robots.startsWith(`User-agent: *\nContent-Signal: ai-train=${signal}, search=${signal}, ai-input=${signal}\n`),
    );
    assert.ok(robots.includes(channel === "prod" ? "Allow: /\n" : "Disallow: /\n"));
    assert.equal(robots.includes("Sitemap:"), channel === "prod");
  });
}

test("published Markdown routes match workflow and documentation sources", () => {
  const expected = [
    ...Object.values(WORKFLOW_SEO_ROUTES).map(({ slug }) => `/${slug}`),
    ...DOC_SOURCES.map(({ slug }) => `/${slug}`),
  ];
  assert.deepEqual(MARKDOWN_ROUTES.map(({ path }) => path).sort(), expected.sort());
  assert.equal(new Set(MARKDOWN_ROUTES.map(({ path }) => path)).size, MARKDOWN_ROUTES.length);
  assert.deepEqual(
    MARKDOWN_ROUTES.find(({ path }) => path === "/"),
    { path: "/", markdownPath: "/index.md" },
  );
  for (const { path, markdownPath } of MARKDOWN_ROUTES.filter(({ path }) => path !== "/")) {
    assert.equal(markdownPath, `${path}.md`);
  }
});

test("workflow Markdown and discovery reuse each route's SEO metadata", () => {
  for (const route of Object.values(WORKFLOW_SEO_ROUTES)) {
    const markdown = createWorkflowMarkdown(route);
    const markdownPath = `/${route.slug || "index"}.md`;
    assert.ok(markdown.startsWith(`Canonical: https://rom-weaver.com/${route.slug}\n\n# ${route.title}\n`));
    assert.ok(markdown.includes(route.description));
    assert.ok(markdown.includes("[Documentation](https://rom-weaver.com/docs.md)"));
    for (const channel of ["prod", "preview"]) {
      const html = createWorkflowRouteHtml(routeShell, route, channel, "Preview");
      assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${markdownPath}" />`));
      assert.equal(html.split('type="text/markdown"').length - 1, 1);
    }
  }
});
