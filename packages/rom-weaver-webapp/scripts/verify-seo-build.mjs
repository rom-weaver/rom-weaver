import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DOC_ROUTES } from "../src/webapp/docs-pages.mjs";
import { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

const packageDir = path.resolve(import.meta.dirname, "..");
const distDir = path.join(packageDir, "dist");
const channel = process.env.ROM_WEAVER_CHANNEL || "prod";
const production = channel === "prod";
const read = (name) => fs.readFileSync(path.join(distDir, name), "utf8");
const assertIncludes = (source, expected, label) => {
  if (!source.includes(expected)) throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
};
const assertCount = (source, expected, count, label) => {
  const actual = source.split(expected).length - 1;
  if (actual !== count)
    throw new Error(`${label} contains ${actual} copies of ${JSON.stringify(expected)}; expected ${count}`);
};
const countVisibleWords = (source) =>
  source
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .trim()
    .split(/\s+/).length;
const docsScreenshotNames = [
  "create-desktop-dark.png",
  "create-desktop-light.png",
  "create-mobile-dark.png",
  "create-mobile-light.png",
  "first-sample-hello-world.png",
  "first-sample-modified-world.png",
  "first-sample-modified-rom.png",
  "weave-desktop-dark.png",
  "weave-desktop-light.png",
  "weave-mobile-dark.png",
  "weave-mobile-light.png",
];

const weaveHtml = read("index.html");
const notFoundHtml = read("404.html");
const createHtml = read("create.html");
const headers = read("_headers");
const llmsTxt = read("llms.txt");
const robots = read("robots.txt");

for (const route of ["weave", "create", "trim", "tools"]) {
  assertIncludes(read(`${route}/index.html`), '<base href="../" />', `${route} static-host route`);
}
assertIncludes(
  headers,
  "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
  "fingerprinted asset cache headers",
);
assertIncludes(headers, "/cache-service-worker.js\n  Cache-Control: no-cache", "service worker cache headers");
assertIncludes(notFoundHtml, '<meta name="robots" content="noindex" />', "404 robots metadata");
assertIncludes(notFoundHtml, 'data-page="not-found"', "404 app state");
assertIncludes(notFoundHtml, 'aria-label="404: Page not found"', "404 heading");
assertIncludes(notFoundHtml, '<header class="masthead">', "404 app masthead");
assertIncludes(notFoundHtml, 'class="btn primary not-found-home" href="/weave"', "404 home action");
assertIncludes(llmsTxt, `# ${SITE_NAME}`, "llms.txt site heading");
for (const url of [
  "https://rom-weaver.com/weave",
  "https://rom-weaver.com/create",
  "https://rom-weaver.com/docs",
  "https://rom-weaver.com/docs/cli",
  "https://rom-weaver.com/docs/self-hosting",
  "https://rom-weaver.com/docs/architecture",
  "https://github.com/rom-weaver/rom-weaver",
]) {
  assertIncludes(llmsTxt, `](${url})`, "llms.txt links");
}
assertIncludes(
  headers,
  "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8",
  "attribution text content type",
);
assertIncludes(weaveHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.patcher.slug}"`, "weave canonical");
assertIncludes(
  read("weave.html"),
  `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.patcher.slug}"`,
  "slashless weave route",
);
assertIncludes(weaveHtml, WORKFLOW_SEO_ROUTES.patcher.description, "weave description");
assertIncludes(createHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.creator.slug}"`, "create canonical");
assertIncludes(createHtml, WORKFLOW_SEO_ROUTES.creator.description, "create description");
assertIncludes(read("create/index.html"), WORKFLOW_SEO_ROUTES.creator.description, "static-host create description");
assertIncludes(weaveHtml, 'aria-selected="true" class="mode" data-mode="patcher"', "weave prerendered workflow");
assertIncludes(createHtml, 'aria-selected="true" class="mode" data-mode="creator"', "create prerendered workflow");
assertIncludes(weaveHtml, 'class="build-version-label"', "preloaded build version");
assertIncludes(weaveHtml, 'class="masthead-threads-full"', "preloaded full thread label");
assertIncludes(weaveHtml, 'class="masthead-threads-short"', "preloaded compact thread label");
assertIncludes(weaveHtml, 'class="masthead-runtime"', "preloaded runtime status slot");
assertIncludes(weaveHtml, 'data-service-worker-enabled="true"', "service-worker build marker");
const runtimeResolver =
  '<span class="masthead-runtime">· web · sw</span><script>try{window.ROM_WEAVER_RESOLVE_SHELL_IDENTITY()}';
for (const route of [
  "index.html",
  "weave.html",
  "create.html",
  "404.html",
  "weave/index.html",
  "create/index.html",
  "trim/index.html",
  "tools/index.html",
]) {
  const html = read(route);
  assertIncludes(html, runtimeResolver, `${route} parser-time runtime status resolver placement`);
  assertCount(html, "ROM_WEAVER_RESOLVE_SHELL_IDENTITY()", 1, `${route} parser-time runtime status resolver`);
}
assertIncludes(
  read("create/index.html"),
  'aria-selected="true" class="mode" data-mode="creator"',
  "static-host create prerendered workflow",
);
assertIncludes(
  weaveHtml,
  `name="robots" content="${production ? "index, follow" : "noindex, nofollow"}"`,
  "weave robots metadata",
);
assertIncludes(weaveHtml, 'data-mode="docs"', "weave guides tab");
assertIncludes(createHtml, 'data-mode="docs"', "create guides tab");

for (const name of docsScreenshotNames) {
  const screenshotPath = path.join(distDir, "docs", "screenshots", name);
  if (!fs.statSync(screenshotPath).isFile()) throw new Error(`docs screenshot is missing: ${name}`);
}
for (const [slug, workflow] of [
  ["docs/apply-rom-patches", "weave"],
  ["docs/create-rom-patches", "create"],
]) {
  const docsHtml = read(`${slug}.html`);
  for (const viewport of ["desktop", "mobile"]) {
    for (const theme of ["dark", "light"]) {
      assertIncludes(
        docsHtml,
        `/docs/screenshots/${workflow}-${viewport}-${theme}.png`,
        `${slug} ${viewport} ${theme} screenshot`,
      );
    }
  }
}

assertIncludes(weaveHtml, '"@type":"SoftwareApplication"', "weave SoftwareApplication JSON-LD");
assertIncludes(weaveHtml, '"@type":"WebSite"', "weave WebSite JSON-LD");
assertIncludes(weaveHtml, `"name":"${SITE_NAME}"`, "canonical site name");
assertIncludes(weaveHtml, `"alternateName":${JSON.stringify(SITE_ALTERNATE_NAMES)}`, "site alternate names");
assertIncludes(createHtml, '"@type":"SoftwareApplication"', "create SoftwareApplication JSON-LD");
assertIncludes(createHtml, '"url":"https://rom-weaver.com/create"', "create JSON-LD canonical url");
if (createHtml.includes('"@type":"WebSite"')) throw new Error("WebSite JSON-LD belongs on the home route only");

for (const route of DOC_ROUTES) {
  const docsHtml = read(`${route.slug}.html`);
  const directoryHtml = read(`${route.slug}/index.html`);
  const canonical = `href="https://rom-weaver.com/${route.slug}"`;
  const robotsDirective = `name="robots" content="${production ? "index, follow" : "noindex, nofollow"}"`;
  assertIncludes(docsHtml, canonical, `${route.slug} canonical`);
  assertIncludes(directoryHtml, canonical, `${route.slug} directory canonical`);
  assertIncludes(docsHtml, route.description, `${route.slug} description`);
  assertIncludes(docsHtml, robotsDirective, `${route.slug} robots metadata`);
  assertIncludes(docsHtml, '<h1 id="', `${route.slug} heading`);
  assertIncludes(docsHtml, `>${route.title}</h1>`, `${route.slug} heading title`);
  if ((docsHtml.match(/<h1\b/g) || []).length !== 1) throw new Error(`${route.slug} must contain exactly one h1`);
  assertIncludes(docsHtml, `data-markdown-source="${route.source}"`, `${route.slug} Markdown source`);
  assertIncludes(docsHtml, 'aria-selected="true" class="mode" data-mode="docs"', `${route.slug} selected guides tab`);
  assertIncludes(
    docsHtml,
    '<button aria-label="Switch to light theme" class="tool"',
    `${route.slug} React theme control`,
  );
  assertIncludes(docsHtml, '<base href="/" />', `${route.slug} asset base`);
  assertIncludes(docsHtml, 'rel="stylesheet" crossorigin href="./assets/', `${route.slug} app stylesheet`);
  const legalPage = route.slug === "docs/notices" || route.slug === "docs/privacy";
  assertIncludes(docsHtml, `"@type":"${legalPage ? "WebPage" : "TechArticle"}"`, `${route.slug} structured data`);
  assertIncludes(docsHtml, 'href="/weave?guide=apply"', `${route.slug} guided Apply link`);
  assertIncludes(docsHtml, 'href="/create?guide=create"', `${route.slug} guided Create link`);
  assertIncludes(docsHtml, 'href="/docs/cli#install"', `${route.slug} CLI installation link`);
  assertIncludes(docsHtml, `href="/${route.slug}#`, `${route.slug} in-page links`);
  assertIncludes(docsHtml, 'aria-label="On this page"', `${route.slug} section rail`);
  for (const section of route.sections) {
    assertIncludes(docsHtml, `href="/${route.slug}#${section.id}"`, `${route.slug} rail link for ${section.id}`);
    assertIncludes(docsHtml, `<h2 id="${section.id}"`, `${route.slug} heading for rail entry ${section.id}`);
  }
  // Documentation links are authored repository-relative; every one of them must have
  // been rewritten to a route or an absolute repository URL.
  const unrewritten = docsHtml.match(/href="(?!https?:)[^"]*\.md(?:#[^"]*)?"/g);
  if (unrewritten) throw new Error(`${route.slug} has unrewritten Markdown links: ${unrewritten.join(", ")}`);
  // Documentation links to the app must be root-relative, so beta, nightly, and PR
  // previews keep the reader on the deployment they are already reading. Only
  // the page metadata below may name the production origin.
  const crossChannel = route.html.match(/href="https:\/\/rom-weaver\.com[^"]*"/g);
  if (crossChannel) throw new Error(`${route.slug} links to production: ${crossChannel.join(", ")}`);
  const guide = route.source.startsWith("docs/guides/");
  const minimumWords = guide ? (route.slug === "docs" || legalPage ? 250 : 500) : 150;
  const wordCount = countVisibleWords(docsHtml);
  if (wordCount < minimumWords) {
    throw new Error(`${route.slug} has ${wordCount} visible words; expected at least ${minimumWords}`);
  }
}

// The guides are rendered to HTML at build time, so `marked` must stay a build
// tool. A parser reaching the bundle would ship MIT-licensed code that the
// attribution inventories - generated from the shipped dependency graph - do
// not cover, on top of the wasted bytes.
const bundledScripts = fs
  .readdirSync(path.join(distDir, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join("assets", name));
for (const script of bundledScripts) {
  if (read(script).includes("markedjs/marked"))
    throw new Error(`${script} bundles the Markdown parser; guides must be rendered at build time`);
}

for (const beta of ["trim", "tools"]) {
  assertIncludes(read(`${beta}/index.html`), 'name="robots" content="noindex, nofollow"', `${beta} noindex`);
  assertIncludes(
    read(`${beta}/index.html`),
    `rel="canonical" href="https://rom-weaver.com/${beta}"`,
    `${beta} self canonical`,
  );
}

if (production) {
  if (weaveHtml.includes("<html data-accent=")) throw new Error("production must use the default madder accent");
  assertIncludes(robots, "Allow: /", "production robots.txt");
  assertIncludes(robots, "Sitemap: https://rom-weaver.com/sitemap.xml", "production robots.txt");
  assertIncludes(read("sitemap.xml"), "https://rom-weaver.com/create", "sitemap");
  for (const route of DOC_ROUTES) {
    assertIncludes(read("sitemap.xml"), `https://rom-weaver.com/${route.slug}`, `${route.slug} sitemap entry`);
  }
  if (headers.includes("X-Robots-Tag")) throw new Error("production headers must not block indexing");
} else {
  const expectedAccent = {
    beta: "woad",
    dev: "madder",
    nightly: "verdigris",
    preview: "plum",
  }[channel];
  if (expectedAccent && expectedAccent !== "madder")
    assertIncludes(weaveHtml, `<html data-accent="${expectedAccent}"`, `${channel} channel accent`);
  assertIncludes(robots, "Disallow: /", `${channel} robots.txt`);
  assertIncludes(headers, "X-Robots-Tag: noindex, nofollow", `${channel} headers`);
  if (fs.existsSync(path.join(distDir, "sitemap.xml"))) throw new Error(`${channel} must not publish a sitemap`);
}

console.log(`SEO build verified for ${channel}`);
