import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDocsMarkdown, readDocLastmod } from "./docs-discovery.mjs";

const source = { file: "how-to/apply-rom-patches.md", slug: "docs/apply-rom-patches" };

test("Markdown exports resolve links without changing code examples", () => {
  const markdown =
    "# Guide\n\n[Formats](../reference/formats.md#bps)\n\n`[Formats](../reference/formats.md#bps)`\n\n```md\n[Formats](../reference/formats.md#bps)\n```\n\n- [Guide][guide]\n\n[guide]: ../reference/cli.md\n\n| Topic | Guide |\n| --- | --- |\n| CLI | [CLI](../reference/cli.md) |\n";
  const result = createDocsMarkdown(source, markdown);
  assert.match(result, /\[Formats\]\(<https:\/\/rom-weaver.com\/docs\/supported-formats.md#bps>\)/);
  assert.ok(result.includes("`[Formats](../reference/formats.md#bps)`"));
  assert.ok(result.includes("```md\n[Formats](../reference/formats.md#bps)\n```"));
  assert.ok(result.includes("- [Guide](<https://rom-weaver.com/docs/cli.md>)"));
  assert.ok(result.includes("| CLI | [CLI](<https://rom-weaver.com/docs/cli.md>) |"));
});

test("Markdown images link to image bytes while repository links keep their navigation URLs", () => {
  const markdown = [
    '![Restored ROM](../screenshots/ppf-undo-restored.webp "Result")',
    "[Screenshot](../screenshots/ppf-undo-restored.webp)",
    "![Remote](https://example.com/image.webp)",
    "`![Literal](../screenshots/ppf-undo-restored.webp)`",
  ].join("\n\n");
  const result = createDocsMarkdown(source, markdown);
  assert.ok(
    result.includes(
      '![Restored ROM](<https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/screenshots/ppf-undo-restored.webp> "Result")',
    ),
  );
  assert.ok(
    result.includes(
      "[Screenshot](<https://github.com/rom-weaver/rom-weaver/blob/main/docs/screenshots/ppf-undo-restored.webp>)",
    ),
  );
  assert.ok(result.includes("![Remote](<https://example.com/image.webp>)"));
  assert.ok(result.includes("`![Literal](../screenshots/ppf-undo-restored.webp)`"));
});

test("Markdown exports resolve HTML media URLs and keep other HTML intact", () => {
  const raw = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs/screenshots";
  const markdown = [
    "<picture>",
    '  <source media="(max-width: 520px)" srcset="../screenshots/a-mobile.avif 1x, ../screenshots/a-mobile@2x.avif 2x" width="10">',
    '  <img src=\'../screenshots/a.webp\' alt="A" width="20">',
    "</picture>",
    "",
    '<img src="https://example.com/remote.webp" alt="Remote">',
    "",
    "```html",
    '<img src="../screenshots/a.webp">',
    "```",
  ].join("\n");
  const result = createDocsMarkdown(source, markdown);
  assert.ok(result.includes(`srcset="${raw}/a-mobile.avif 1x, ${raw}/a-mobile@2x.avif 2x" width="10"`));
  assert.ok(result.includes(`<img src='${raw}/a.webp' alt="A" width="20">`));
  assert.ok(result.includes('<img src="https://example.com/remote.webp" alt="Remote">'));
  assert.ok(result.includes('```html\n<img src="../screenshots/a.webp">\n```'));
});

test("the Identify guide export has no relative HTML media URLs", () => {
  const file = "how-to/identify-roms-browser.md";
  const markdown = fs.readFileSync(new URL(`../../../docs/${file}`, import.meta.url), "utf8");
  const result = createDocsMarkdown({ file, slug: "docs/identify-roms-browser" }, markdown);
  const urls = [...result.matchAll(/\s(?:src|srcset)="([^"]*)"/g)].flatMap((match) =>
    match[1].split(",").map((candidate) => candidate.trim().split(/\s+/)[0]),
  );
  assert.ok(urls.length > 0);
  for (const url of urls) assert.match(url, /^https:\/\//, url);
});

test("lastmod is omitted for dirty files and missing history", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seo-history-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  const file = path.join(directory, "guide.md");
  fs.writeFileSync(file, "# Guide\n");
  assert.equal(readDocLastmod(file, directory), null);
  git(["init"]);
  git(["add", "guide.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "docs: add guide"]);
  assert.match(readDocLastmod(file, directory), /^\d{4}-\d{2}-\d{2}T/);
  fs.appendFileSync(file, "\nChanged\n");
  assert.equal(readDocLastmod(file, directory), null);
  git(["add", "guide.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "docs: update guide"]);
  const shallow = path.join(directory, "shallow");
  git(["clone", "--depth=1", `file://${directory}`, shallow]);
  assert.equal(readDocLastmod(path.join(shallow, "guide.md"), shallow), null);
});
