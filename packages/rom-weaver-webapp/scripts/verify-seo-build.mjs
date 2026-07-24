import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

const packageDir = path.resolve(import.meta.dirname, "..");
const distDir = path.join(packageDir, "dist");
const channel = process.env.ROM_WEAVER_CHANNEL || "prod";
const production = channel === "prod";
const read = (name) => fs.readFileSync(path.join(distDir, name), "utf8");
const assertIncludes = (source, expected, label) => {
  if (!source.includes(expected)) throw new Error(`${label} is missing ${JSON.stringify(expected)}`);
};

const weaveHtml = read("index.html");
const createHtml = read("create.html");
const headers = read("_headers");
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
assertIncludes(
  headers,
  "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8",
  "attribution text content type",
);
assertIncludes(weaveHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.patcher.slug}"`, "weave canonical");
assertIncludes(weaveHtml, WORKFLOW_SEO_ROUTES.patcher.description, "weave description");
assertIncludes(createHtml, `href="https://rom-weaver.com/${WORKFLOW_SEO_ROUTES.creator.slug}"`, "create canonical");
assertIncludes(createHtml, WORKFLOW_SEO_ROUTES.creator.description, "create description");
assertIncludes(read("create/index.html"), WORKFLOW_SEO_ROUTES.creator.description, "static-host create description");
assertIncludes(weaveHtml, 'aria-selected="true" class="mode" data-mode="patcher"', "weave prerendered workflow");
assertIncludes(createHtml, 'aria-selected="true" class="mode" data-mode="creator"', "create prerendered workflow");
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
assertIncludes(createHtml, '"@type":"SoftwareApplication"', "create SoftwareApplication JSON-LD");
assertIncludes(createHtml, '"url":"https://rom-weaver.com/create"', "create JSON-LD canonical url");

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
