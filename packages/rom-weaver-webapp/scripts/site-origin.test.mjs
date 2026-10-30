import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createApiCatalogSource, createOpenApiSource } from "../src/webapp/api-catalog.mjs";
import { DOC_SOURCES, SITE_ORIGIN, SITE_SAMPLE_PATHS } from "../src/webapp/docs-routing.mjs";
import { createDocsMarkdown } from "./docs-discovery.mjs";
import { PRODUCTION_SITE_ORIGIN, resolveSiteOrigin } from "./vite-config/channel.mjs";
import { createLlmsSource, rootStaticAssetSourcesForChannel } from "./vite-config/root-static-assets.mjs";
import { createWorkflowMarkdown } from "./vite-config/seo-html.mjs";
import { WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

const NIGHTLY = "https://nightly.rom-weaver.com";
const llmsPath = rootStaticAssetSourcesForChannel("nightly")["/llms.txt"];

test("an unset site origin builds for production", () => {
  assert.equal(resolveSiteOrigin(undefined), PRODUCTION_SITE_ORIGIN);
  assert.equal(resolveSiteOrigin("  "), SITE_ORIGIN);
});

test("a site origin is normalized and must be a bare http(s) origin", () => {
  assert.equal(resolveSiteOrigin("https://nightly.rom-weaver.com/"), NIGHTLY);
  assert.throws(() => resolveSiteOrigin("nightly.rom-weaver.com"), /not a URL/);
  assert.throws(() => resolveSiteOrigin("https://example.test/rom-weaver/"), /without a path/);
  assert.throws(() => resolveSiteOrigin("ftp://example.test"), /http\(s\) origin/);
});

test("llms.txt built for the nightly channel names nightly and no production host", () => {
  const llms = createLlmsSource(llmsPath, NIGHTLY);
  assert.ok(llms.includes(`](${NIGHTLY}/apply-rom-patches)`));
  assert.ok(llms.includes(`](${NIGHTLY}/index.md)`));
  assert.equal(llms.includes(SITE_ORIGIN), false);
  assert.ok(llms.includes("https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/README.md"));
});

test("llms.txt is unchanged for production", () => {
  assert.equal(createLlmsSource(llmsPath, SITE_ORIGIN), fs.readFileSync(llmsPath, "utf8"));
});

test("openapi and api-catalog name the serving origin", () => {
  const openapi = JSON.parse(createOpenApiSource(NIGHTLY));
  assert.deepEqual(openapi.servers, [{ url: NIGHTLY }]);
  assert.ok(openapi.info.description.includes(`${NIGHTLY}/docs/webapp-integration#url-sessions`));
  const catalog = createApiCatalogSource(NIGHTLY);
  assert.ok(catalog.includes(`"${NIGHTLY}/.well-known/api-catalog"`));
  assert.equal(catalog.includes(SITE_ORIGIN), false);
  assert.equal(createApiCatalogSource(), createApiCatalogSource(SITE_ORIGIN));
});

test("Markdown alternates link to the serving origin and keep the production canonical", () => {
  const source = { file: "how-to/apply-rom-patches.md", slug: "docs/apply-rom-patches" };
  const docs = createDocsMarkdown(source, "# Guide\n\n[CLI](../reference/cli.md) [App](/compress-files)\n", NIGHTLY);
  assert.ok(docs.startsWith(`Canonical: ${SITE_ORIGIN}/docs/apply-rom-patches\n`));
  assert.ok(docs.includes(`[CLI](<${NIGHTLY}/docs/cli.md>)`));
  assert.ok(docs.includes(`[App](<${NIGHTLY}/compress-files>)`));
  const absolute = createDocsMarkdown(
    source,
    `[Apply](${SITE_ORIGIN}/apply-rom-patches?mode=rom#top) [Other](https://rom-weaver.com.example/x)\n`,
    NIGHTLY,
  );
  assert.ok(absolute.includes(`[Apply](<${NIGHTLY}/apply-rom-patches?mode=rom#top>)`));
  assert.ok(absolute.includes("[Other](<https://rom-weaver.com.example/x>)"));
  const workflow = createWorkflowMarkdown(WORKFLOW_SEO_ROUTES.compress, NIGHTLY);
  assert.ok(workflow.startsWith(`Canonical: ${SITE_ORIGIN}/compress-files\n`));
  assert.ok(workflow.includes(`[Open in browser](${NIGHTLY}/compress-files)`));
  assert.ok(workflow.includes(`[Documentation](${NIGHTLY}/docs.md)`));
  for (const route of [...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]) {
    const expanded = createWorkflowMarkdown(route, NIGHTLY);
    assert.ok(expanded.startsWith(`Canonical: ${SITE_ORIGIN}/${route.slug}\n`));
    assert.equal(expanded.includes(`](<${SITE_ORIGIN}`), false, `${route.slug} guide links to production`);
    assert.ok(expanded.includes(`[Full guide](${NIGHTLY}/docs/`), `${route.slug} guide origin`);
  }
  assert.ok(
    workflow.includes(`[container table](<${NIGHTLY}/docs/supported-formats.md#container-and-compression-formats>)`),
  );
});

test("no published Markdown alternate links to production from another origin", () => {
  const docsRoot = path.resolve(import.meta.dirname, "../../../docs");
  for (const source of DOC_SOURCES) {
    const file = path.join(docsRoot, source.file);
    if (!fs.existsSync(file)) continue;
    const markdown = createDocsMarkdown(source, fs.readFileSync(file, "utf8"), NIGHTLY);
    assert.equal(markdown.includes(`](<${SITE_ORIGIN}`), false, `${source.file} links to production`);
    for (const block of markdown.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1/gm)) {
      assert.equal(
        new RegExp(`${SITE_ORIGIN}/[A-Za-z0-9._-]+(?![A-Za-z0-9._~%/-])`).test(block[0]),
        false,
        `${source.file} has a sample command that targets production`,
      );
    }
  }
});

test("Markdown alternates point only fenced sample commands at the serving origin", () => {
  const source = { file: "tutorials/cli-first-weave.md", slug: "docs/cli-first-weave" };
  const markdown = [
    `Prose names rom-weaver.com and \`curl ${SITE_ORIGIN}/inline.zip\`.`,
    "",
    "```bash",
    `curl -O ${SITE_ORIGIN}/first-weave.zip`,
    `curl -fsSL ${SITE_ORIGIN}/install.sh | sh`,
    `curl ${SITE_ORIGIN}/docs/deep.md ${SITE_ORIGIN}.example/x https://rom-weaver.com.example/y`,
    "```",
    "",
  ].join("\n");
  const result = createDocsMarkdown(source, markdown, NIGHTLY);
  assert.ok(result.includes(`curl -O ${NIGHTLY}/first-weave.zip\n`));
  assert.ok(result.includes(`curl -fsSL ${NIGHTLY}/install.sh | sh\n`));
  assert.ok(result.includes(`Prose names rom-weaver.com and \`curl ${SITE_ORIGIN}/inline.zip\`.`));
  assert.ok(
    result.includes(`curl ${SITE_ORIGIN}/docs/deep.md ${SITE_ORIGIN}.example/x https://rom-weaver.com.example/y\n`),
  );
  assert.equal(createDocsMarkdown(source, markdown), `Canonical: ${SITE_ORIGIN}/docs/cli-first-weave\n\n${markdown}`);
});

test("repository sample links resolve to the file the site serves", () => {
  const source = { file: "tutorials/patch-compressed-disc.md", slug: "docs/patch-compressed-disc" };
  const markdown = SITE_SAMPLE_PATHS.map((file) => `[f](../samples/${file.slice("docs/samples/".length)})`).join("\n");
  const result = createDocsMarkdown(source, markdown, NIGHTLY);
  for (const file of SITE_SAMPLE_PATHS) assert.ok(result.includes(`<${NIGHTLY}/${file}>`));
});

test("every shared sample path exists in the repository and is served by the site", () => {
  const served = rootStaticAssetSourcesForChannel("prod");
  for (const file of SITE_SAMPLE_PATHS) {
    assert.ok(served[`/${file}`], `${file} is not served`);
    assert.ok(fs.existsSync(path.resolve(import.meta.dirname, "../../..", file)), `${file} is missing`);
  }
});
