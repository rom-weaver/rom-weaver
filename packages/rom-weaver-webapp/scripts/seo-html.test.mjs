import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MARKDOWN_ROUTES } from "../functions/markdown-routes.js";
import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import {
  WORKFLOW_ENTRY_ROUTES,
  readWorkflowEntryFromPathname,
  WORKFLOW_SEO_ROUTES,
} from "../src/webapp/workflow-seo.mjs";
import {
  createRobotsSource,
  createSitemapSource,
  createWorkflowRouteHtml,
  createWorkflowMarkdown,
  injectLdJson,
  makeBetaRouteNoindex,
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
  for (const route of [...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]) {
    assert.ok(!route.description.toLocaleLowerCase().includes("beta"), route.slug || "home");
  }
});

test("sitemap lastmod values are ISO dates or absent, and never on a Markdown URL", () => {
  const sitemap = createSitemapSource();
  for (const [, location, lastmod] of sitemap.matchAll(/<loc>(.*?)<\/loc>(?:<lastmod>(.*?)<\/lastmod>)?/g)) {
    assert.ok(!location.endsWith(".md"), location);
    if (lastmod) assert.match(lastmod, /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/, location);
  }
});

test("workflow pages take their lastmod from the newest commit of their text sources", (context) => {
  // A throwaway repository, so the assertion holds in the shallow clones CI uses.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seo-sitemap-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (date, ...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: directory,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "ignore",
    });
  const files = [
    "src/webapp/workflow-seo.mjs",
    "src/presentation/localization/messages.ts",
    "src/webapp/components/home-page.tsx",
    "src/webapp/components/home-sections.tsx",
    "src/webapp/components/home-loom.tsx",
    "src/wasm/generated/rom-weaver-format-metadata.ts",
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), "// text\n");
  }
  assert.doesNotMatch(
    createSitemapSource({ root: directory, repo: directory }),
    /<loc>https:\/\/rom-weaver.com\/compress<\/loc><lastmod>/,
  );
  git("2026-01-01T00:00:00Z", "init");
  git("2026-01-01T00:00:00Z", "add", ".");
  git("2026-01-01T00:00:00Z", "commit", "-m", "feat: add sources");
  fs.appendFileSync(path.join(directory, "src/webapp/components/home-loom.tsx"), "// changed\n");
  git("2026-02-01T00:00:00Z", "add", ".");
  git("2026-02-01T00:00:00Z", "commit", "-m", "fix: change landing");
  const sitemap = createSitemapSource({ root: directory, repo: directory });
  const lastmodOf = (slug) =>
    sitemap.match(new RegExp(`<loc>https://rom-weaver.com/${slug}</loc><lastmod>([^<]+)</lastmod>`))?.[1];
  for (const route of [...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]) {
    assert.match(lastmodOf(route.slug) ?? "", /^\d{4}-\d{2}-\d{2}T/, route.slug || "home");
  }
  // The landing change is newer than the shared sources, so only the apex follows it.
  assert.ok(lastmodOf("") > lastmodOf("compress"));
});

test("the Notices entry takes the injected generated-page date, and none when it is unknown", () => {
  const notices = (sitemap) =>
    sitemap.match(/<loc>https:\/\/rom-weaver.com\/docs\/notices<\/loc><lastmod>([^<]+)<\/lastmod>/)?.[1];
  assert.equal(notices(createSitemapSource({ generatedLastmod: "2026-01-02" })), "2026-01-02");
  assert.doesNotMatch(createSitemapSource({ generatedLastmod: null }), /docs\/notices<\/loc><lastmod>/);
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
    "create-rom-patch",
    "extract",
    "identify-rom",
    "m3u-playlist",
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
    ...[...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)].map(({ slug }) => `/${slug}`),
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
  for (const route of [...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]) {
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

test("beta tool pages get their own title, social titles, and channel badge", () => {
  const shell = `${routeShell.replace("</head>", '<meta name="robots" content="index, follow" />\n</head>')}`;
  for (const [slug, name] of [
    ["save-editor", "Save Editor"],
    ["trim-rom", "Trim ROM"],
    ["whats-new", "What's new"],
  ]) {
    const prod = makeBetaRouteNoindex(shell, slug, "prod", "Production");
    assert.ok(prod.includes(`<title>${name} | rom-weaver</title>`), `${slug} title`);
    assert.ok(prod.includes(`<meta property="og:title" content="${name} | rom-weaver">`), `${slug} og:title`);
    assert.ok(prod.includes(`<meta name="twitter:title" content="${name} | rom-weaver">`), `${slug} twitter:title`);
    assert.ok(prod.includes('content="noindex, nofollow"'), `${slug} noindex`);
    const beta = makeBetaRouteNoindex(shell, slug, "beta", "Beta");
    assert.ok(beta.includes(`<title>${name} | rom-weaver Beta</title>`), `${slug} beta title`);
  }
});

test("task entries resolve static-host variants and avoid documentation paths", () => {
  for (const [slug, route] of Object.entries(WORKFLOW_ENTRY_ROUTES)) {
    for (const pathname of [`/${slug}`, `/${slug}/`, `/roms/${slug}.html`, `/roms/${slug}/index.html`]) {
      assert.equal(readWorkflowEntryFromPathname(pathname), slug);
    }
    assert.equal(readWorkflowEntryFromPathname(`/docs/${slug}`), null);
    assert.ok(createSitemapSource().includes(`<loc>https://rom-weaver.com/${slug}</loc>`));
    const html = createWorkflowRouteHtml(routeShell, route, "prod", "");
    assert.ok(html.includes(`<title>${route.title}</title>`));
    assert.ok(html.includes(`href="https://rom-weaver.com/${slug}"`));
  }
  assert.equal(readWorkflowEntryFromPathname("/create-rom-patch"), null);
});
