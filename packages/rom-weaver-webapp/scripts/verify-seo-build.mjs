import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
  "https://github.com/rom-weaver/rom-weaver",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/README.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/cli.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/webapp-integration.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/self-hosting.md",
  "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/ARCHITECTURE.md",
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

assertIncludes(weaveHtml, '"@type":"SoftwareApplication"', "weave SoftwareApplication JSON-LD");
assertIncludes(weaveHtml, '"@type":"WebSite"', "weave WebSite JSON-LD");
assertIncludes(weaveHtml, `"name":"${SITE_NAME}"`, "canonical site name");
assertIncludes(weaveHtml, `"alternateName":${JSON.stringify(SITE_ALTERNATE_NAMES)}`, "site alternate names");
assertIncludes(createHtml, '"@type":"SoftwareApplication"', "create SoftwareApplication JSON-LD");
assertIncludes(createHtml, '"url":"https://rom-weaver.com/create"', "create JSON-LD canonical url");
if (createHtml.includes('"@type":"WebSite"')) throw new Error("WebSite JSON-LD belongs on the home route only");

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
