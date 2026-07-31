import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DOC_ROUTES } from "../src/webapp/docs-pages.mjs";
import { criticalAssetLinkHeaders } from "./critical-asset-hints.mjs";
import { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

const packageDir = path.resolve(import.meta.dirname, "..");
const distDir = path.join(packageDir, "dist");
const channel = process.env.ROM_WEAVER_CHANNEL || "prod";
const production = channel === "prod";
const read = (name) => fs.readFileSync(path.join(distDir, name), "utf8");
const assertIncludes = (source, expected, label) => {
  if (!source.includes(expected)) throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
};
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// preact-render-to-string does not promise React's attribute order, so assert per attribute instead of
// on one baked-in string. Each attribute is matched behind required whitespace rather than `\b`: a
// word boundary also sits inside `data-aria-selected="true"`, which would then satisfy a check for
// `aria-selected="true"`. `[^>]*` keeps every lookahead inside the one opening tag.
const assertTagAttributes = (source, tag, attributes, label) => {
  const pattern = new RegExp(
    `<${escapeRegExp(tag)}\\b${attributes.map((attribute) => `(?=[^>]*\\s${escapeRegExp(attribute)})`).join("")}[^>]*>`,
  );
  if (!pattern.test(source))
    throw new Error(
      `${label} is missing <${tag}> with attributes ${attributes.map((attribute) => JSON.stringify(attribute)).join(", ")}`,
    );
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
const docsScreenshotCaptures = [
  "apply-output-desktop-dark",
  "apply-output-desktop-light",
  "apply-output-mobile-dark",
  "apply-output-mobile-light",
  "apply-patches-desktop-dark",
  "apply-patches-desktop-light",
  "apply-patches-mobile-dark",
  "apply-patches-mobile-light",
  "bundle-output-desktop-dark",
  "bundle-output-desktop-light",
  "bundle-output-mobile-dark",
  "bundle-output-mobile-light",
  "create-inputs-desktop-dark",
  "create-inputs-desktop-light",
  "create-inputs-mobile-dark",
  "create-inputs-mobile-light",
  "create-output-desktop-dark",
  "create-output-desktop-light",
  "create-output-mobile-dark",
  "create-output-mobile-light",
];
const docsScreenshotNames = [
  ...docsScreenshotCaptures.flatMap((name) => [`${name}.avif`, `${name}.webp`]),
  "first-sample-hello-world.webp",
  "first-sample-modified-world.webp",
  "first-sample-modified-rom.webp",
];

const applyHtml = read("index.html");
const notFoundHtml = read("404.html");
const createHtml = read("create.html");
const headers = read("_headers");
const redirects = read("_redirects");
const llmsTxt = read("llms.txt");
const robots = read("robots.txt");

for (const route of ["apply", "create", "trim", "tools"]) {
  assertIncludes(read(`${route}/index.html`), '<base href="../" />', `${route} static-host route`);
}
assertIncludes(
  headers,
  "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
  "fingerprinted asset cache headers",
);
assertIncludes(headers, "/cache-service-worker.js\n  Cache-Control: no-cache", "service worker cache headers");
// The Early Hints preload has to name the exact hashed URLs the document requests; a stale
// hint would fetch a dead asset and leave the real ones on the post-parse critical path.
// Derived from the same module the build emits from, so the check cannot drift from it.
for (const link of criticalAssetLinkHeaders(applyHtml)) {
  assertIncludes(headers, link, "critical asset preload hint");
}
assertIncludes(notFoundHtml, '<meta name="robots" content="noindex" />', "404 robots metadata");
assertIncludes(notFoundHtml, 'data-page="not-found"', "404 app state");
assertIncludes(notFoundHtml, 'aria-label="404: Page not found"', "404 heading");
assertTagAttributes(notFoundHtml, "header", ['class="masthead"'], "404 app masthead");
assertTagAttributes(notFoundHtml, "a", ['class="btn primary not-found-home"', 'href="/apply"'], "404 home action");
assertTagAttributes(notFoundHtml, "a", ['class="btn ghost not-found-docs"', 'href="/docs"'], "404 docs action");
assertIncludes(notFoundHtml, "That page is not here.", "404 recovery heading");
assertTagAttributes(
  notFoundHtml,
  "a",
  ['aria-selected="false"', 'data-mode="patcher"', 'class="mode"'],
  "404 inactive workflow tab",
);
if (/<a\b[^>]*\baria-selected="true"[^>]*>/.test(notFoundHtml)) {
  throw new Error("404 page marks a workflow tab as selected");
}
if (notFoundHtml.includes("\u2014")) throw new Error("404 page contains an em dash");
for (const source of ["/weave", "/weave/", "/weave.html", "/weave/index.html"]) {
  assertIncludes(redirects, `${source} /apply 301`, `${source} compatibility redirect`);
}
assertIncludes(llmsTxt, `# ${SITE_NAME}`, "llms.txt site heading");
for (const url of [
  "https://rom-weaver.com/apply",
  "https://rom-weaver.com/create",
  "https://rom-weaver.com/docs",
  "https://rom-weaver.com/docs/apply-rom-patches",
  "https://rom-weaver.com/docs/cli",
  "https://rom-weaver.com/docs/create-bundles",
  "https://rom-weaver.com/docs/create-rom-patches",
  "https://rom-weaver.com/docs/faq",
  "https://rom-weaver.com/docs/self-hosting",
  "https://rom-weaver.com/docs/architecture",
  "https://github.com/rom-weaver/rom-weaver",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/README.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/usage/README.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/hosting/cli.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/hosting/webapp-integration.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/hosting/self-hosting.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/development/ARCHITECTURE.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/.github/RELEASING.md",
]) {
  assertIncludes(llmsTxt, `](${url})`, "llms.txt links");
}
assertIncludes(
  headers,
  `Content-Signal: ai-train=no, search=${production ? "yes" : "no"}, ai-input=yes`,
  `${channel} content signal`,
);
assertIncludes(
  headers,
  "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8",
  "attribution text content type",
);
assertIncludes(applyHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.patcher.slug}"`, "apply canonical");
assertIncludes(
  read("apply.html"),
  `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.patcher.slug}"`,
  "slashless apply route",
);
assertIncludes(applyHtml, WORKFLOW_SEO_ROUTES.patcher.description, "apply description");
assertIncludes(createHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.creator.slug}"`, "create canonical");
assertIncludes(createHtml, WORKFLOW_SEO_ROUTES.creator.description, "create description");
assertIncludes(read("create/index.html"), WORKFLOW_SEO_ROUTES.creator.description, "static-host create description");
assertTagAttributes(
  applyHtml,
  "a",
  ['aria-selected="true"', 'class="mode"', 'data-mode="patcher"'],
  "apply prerendered workflow",
);
assertTagAttributes(
  createHtml,
  "a",
  ['aria-selected="true"', 'class="mode"', 'data-mode="creator"'],
  "create prerendered workflow",
);
assertIncludes(applyHtml, 'class="build-version-label"', "preloaded build version");
assertIncludes(applyHtml, 'class="masthead-threads-full"', "preloaded full thread label");
assertIncludes(applyHtml, 'class="masthead-threads-short"', "preloaded compact thread label");
assertIncludes(applyHtml, 'class="masthead-runtime"', "preloaded runtime status slot");
assertIncludes(applyHtml, 'data-service-worker-enabled="true"', "service-worker build marker");
const runtimeResolver =
  '<span class="masthead-runtime">· web · sw</span><script>try{window.ROM_WEAVER_RESOLVE_SHELL_IDENTITY()}';
for (const route of [
  "index.html",
  "apply.html",
  "create.html",
  "404.html",
  "apply/index.html",
  "create/index.html",
  "trim/index.html",
  "tools/index.html",
]) {
  const html = read(route);
  assertIncludes(html, runtimeResolver, `${route} parser-time runtime status resolver placement`);
  assertCount(html, "ROM_WEAVER_RESOLVE_SHELL_IDENTITY()", 1, `${route} parser-time runtime status resolver`);
}
assertTagAttributes(
  read("create/index.html"),
  "a",
  ['aria-selected="true"', 'class="mode"', 'data-mode="creator"'],
  "static-host create prerendered workflow",
);
assertIncludes(
  applyHtml,
  `name="robots" content="${production ? "index, follow" : "noindex, nofollow"}"`,
  "weave robots metadata",
);
assertIncludes(applyHtml, 'data-mode="docs"', "apply guides tab");
assertIncludes(createHtml, 'data-mode="docs"', "create guides tab");

for (const name of docsScreenshotNames) {
  const screenshotPath = path.join(distDir, "docs", "screenshots", name);
  if (!fs.statSync(screenshotPath).isFile()) throw new Error(`docs screenshot is missing: ${name}`);
}
for (const [slug, captures] of [
  ["docs/apply-rom-patches", ["apply-patches", "apply-output"]],
  ["docs/create-rom-patches", ["create-inputs", "create-output"]],
  ["docs/create-bundles", ["bundle-output"]],
]) {
  const docsHtml = read(`${slug}.html`);
  for (const capture of captures) {
    for (const viewport of ["desktop", "mobile"]) {
      for (const theme of ["dark", "light"]) {
        for (const extension of ["avif", "webp"])
          assertIncludes(
            docsHtml,
            `/docs/screenshots/${capture}-${viewport}-${theme}.${extension}`,
            `${slug} ${capture} ${viewport} ${theme} ${extension} screenshot`,
          );
      }
    }
  }
}

assertIncludes(applyHtml, '"@type":"SoftwareApplication"', "apply SoftwareApplication JSON-LD");
assertIncludes(applyHtml, '"@type":"WebSite"', "apply WebSite JSON-LD");
assertIncludes(applyHtml, `"name":"${SITE_NAME}"`, "canonical site name");
assertIncludes(applyHtml, `"alternateName":${JSON.stringify(SITE_ALTERNATE_NAMES)}`, "site alternate names");
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
  assertTagAttributes(
    docsHtml,
    "a",
    ['aria-selected="true"', 'class="mode"', 'data-mode="docs"'],
    `${route.slug} selected guides tab`,
  );
  assertTagAttributes(
    docsHtml,
    "button",
    ['aria-label="Switch to light theme"', 'class="tool"'],
    `${route.slug} theme control`,
  );
  assertIncludes(docsHtml, '<base href="/" />', `${route.slug} asset base`);
  assertIncludes(docsHtml, 'rel="stylesheet" crossorigin href="./assets/', `${route.slug} app stylesheet`);
  const legalPage = route.slug === "docs/notices" || route.slug === "docs/privacy";
  assertIncludes(docsHtml, `"@type":"${legalPage ? "WebPage" : "TechArticle"}"`, `${route.slug} structured data`);
  // The guided-sample offer is the hub's, not every page's: the guides all
  // closing on the same three buttons made it furniture. Each guide still reaches
  // the samples through the prose links its own author wrote.
  if (route.slug === "docs") {
    assertIncludes(docsHtml, 'href="/apply?guide=apply"', `${route.slug} guided Apply link`);
    assertIncludes(docsHtml, 'href="/create?guide=create"', `${route.slug} guided Create link`);
    assertIncludes(docsHtml, 'href="/apply?guide=bundle"', `${route.slug} guided Bundle link`);
    assertIncludes(docsHtml, 'href="/docs/faq"', `${route.slug} FAQ link`);
    assertIncludes(docsHtml, 'href="/docs/get-started"', `${route.slug} browser usage link`);
    assertIncludes(docsHtml, 'href="/docs/cli"', `${route.slug} CLI usage link`);
    assertIncludes(docsHtml, 'href="/docs/self-hosting"', `${route.slug} self-hosting link`);
  }
  // The hub is an index with no headings of its own, so it has neither in-page
  // anchors nor an outline to rail. Every other page must have both.
  if (route.sections.length > 0) {
    assertIncludes(docsHtml, `href="/${route.slug}#`, `${route.slug} in-page links`);
    assertIncludes(docsHtml, 'aria-label="On this page"', `${route.slug} section rail`);
  }
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
  const guide = route.source.startsWith("docs/usage/");
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
  if (applyHtml.includes("<html data-accent=")) throw new Error("production must use the default madder accent");
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
    assertIncludes(applyHtml, `<html data-accent="${expectedAccent}"`, `${channel} channel accent`);
  assertIncludes(robots, "Disallow: /", `${channel} robots.txt`);
  assertIncludes(headers, "X-Robots-Tag: noindex, nofollow", `${channel} headers`);
  if (fs.existsSync(path.join(distDir, "sitemap.xml"))) throw new Error(`${channel} must not publish a sitemap`);
}

// A route missing from the precache is only visible offline, on a first visit to that
// route - the one case no test navigates through. Assert it here instead, where the
// generated manifest is on disk.
const precacheManifest = read("cache-service-worker.js");
assertIncludes(precacheManifest, '"404.html"', "404 precache entry");
for (const slug of [...DOC_ROUTES.map((route) => route.slug), "apply", "create", "tools", "trim"]) {
  assertIncludes(precacheManifest, `"${slug}/index.html"`, `${slug} precache entry`);
}

console.log(`SEO build verified for ${channel}`);
