import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDocsMarkdown, readFileLastmods } from "./docs-discovery.mjs";
import { DOCS_SCREENSHOT_NAMES } from "./docs-screenshot-manifest.mjs";

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

test("Markdown exports point HTML screenshots at the serving deployment and keep other HTML intact", () => {
  const site = "https://nightly.rom-weaver.com";
  const raw = "https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/docs";
  const markdown = [
    "<picture>",
    '  <source media="(max-width: 520px)" srcset="../screenshots/ppf-undo-restored.webp 1x, ../screenshots/ppf-undo-restored.webp 2x" width="10">',
    '  <img src=\'../screenshots/ppf-undo-restored.webp\' alt="A" width="20">',
    "</picture>",
    "",
    '<img src="../screenshots/not-served.webp" alt="Unserved">',
    '<img src="https://example.com/remote.webp" alt="Remote">',
    "",
    "```html",
    '<img src="../screenshots/ppf-undo-restored.webp">',
    "```",
  ].join("\n");
  const result = createDocsMarkdown(source, markdown, site);
  const served = `${site}/docs/screenshots/ppf-undo-restored.webp`;
  assert.ok(result.includes(`srcset="${served} 1x, ${served} 2x" width="10"`));
  assert.ok(result.includes(`<img src='${served}' alt="A" width="20">`));
  assert.ok(result.includes(`<img src="${raw}/screenshots/not-served.webp" alt="Unserved">`));
  assert.ok(result.includes('<img src="https://example.com/remote.webp" alt="Remote">'));
  assert.ok(result.includes('```html\n<img src="../screenshots/ppf-undo-restored.webp">\n```'));
});

test("the Identify guide export points every HTML screenshot at a file the site serves", () => {
  const file = "how-to/identify-roms-browser.md";
  const markdown = fs.readFileSync(new URL(`../../../docs/${file}`, import.meta.url), "utf8");
  const site = "https://nightly.rom-weaver.com";
  const result = createDocsMarkdown({ file, slug: "docs/identify-roms-browser" }, markdown, site);
  const urls = [...result.matchAll(/\s(?:src|srcset)="([^"]*)"/g)].flatMap((match) =>
    match[1].split(",").map((candidate) => candidate.trim().split(/\s+/)[0]),
  );
  assert.ok(urls.length > 0);
  for (const url of urls) {
    assert.ok(url.startsWith(`${site}/docs/screenshots/`), url);
    assert.ok(DOCS_SCREENSHOT_NAMES.includes(url.slice(`${site}/docs/screenshots/`.length)), url);
  }
});

test("lastmod is omitted for dirty files and missing history", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seo-history-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  const lastmod = (file, cwd = directory) => readFileLastmods([file], cwd).get(file);
  const file = path.join(directory, "guide.md");
  fs.writeFileSync(file, "# Guide\n");
  assert.equal(lastmod(file), null);
  git(["init"]);
  git(["add", "guide.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "docs: add guide"]);
  assert.match(lastmod(file), /^\d{4}-\d{2}-\d{2}T/);
  fs.appendFileSync(file, "\nChanged\n");
  assert.equal(lastmod(file), null);
  git(["add", "guide.md"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "docs: update guide"]);
  const shallow = path.join(directory, "shallow");
  git(["clone", "--depth=1", `file://${directory}`, shallow]);
  assert.equal(lastmod(path.join(shallow, "guide.md"), shallow), null);
});

const gitAt = (cwd, args, date) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: "ignore",
  });

test("lastmods dates each file in one call by its own last change, including a merge that edits it", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seo-history-batch-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (args, date) => gitAt(directory, args, date);
  const files = ["shared.md", "older.md", "dirty.md", "untracked.md", "renamed.md", "moved.md"].map((name) =>
    path.join(directory, name),
  );
  const [shared, older, dirty, untracked, renamed, moved] = files;
  git(["init", "--initial-branch=main"]);
  for (const file of [shared, older, dirty, renamed]) fs.writeFileSync(file, "one\ntwo\nthree\n");
  git(["add", "."]);
  git(["commit", "-m", "docs: add guides"], "2026-01-01T00:00:00Z");
  git(["switch", "-c", "topic"]);
  fs.writeFileSync(shared, "one\ntwo\nthree topic\n");
  git(["commit", "-am", "docs: topic edit"], "2026-01-02T00:00:00Z");
  git(["switch", "main"]);
  fs.writeFileSync(shared, "one main\ntwo\nthree\n");
  git(["commit", "-am", "docs: main edit"], "2026-01-03T00:00:00Z");
  git(["merge", "--no-ff", "--no-edit", "topic"], "2026-01-04T00:00:00Z");
  fs.appendFileSync(dirty, "four\n");
  fs.writeFileSync(untracked, "new\n");
  git(["mv", "renamed.md", "moved.md"]);

  assert.deepEqual(
    readFileLastmods(files, directory),
    new Map([
      [shared, "2026-01-04T00:00:00.000Z"],
      [older, "2026-01-01T00:00:00.000Z"],
      [dirty, null],
      [untracked, null],
      [renamed, null],
      [moved, null],
    ]),
  );
});

test("lastmods match files from a symlinked or diff.relative subdirectory", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "seo-history-paths-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, "repo");
  const date = "2026-01-05T00:00:00Z";
  const git = (args) => gitAt(repo, args, date);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(repo, "site"));
  fs.writeFileSync(path.join(repo, "docs", "guide.md"), "# Guide\n");
  git(["init"]);
  git(["add", "."]);
  git(["commit", "-m", "docs: add guide"]);
  fs.symlinkSync(repo, path.join(directory, "link"));

  for (const [name, root, relative] of [
    ["symlinked checkout", path.join(directory, "link"), "false"],
    ["diff.relative", repo, "true"],
  ]) {
    await context.test(name, () => {
      git(["config", "diff.relative", relative]);
      const file = path.join(root, "docs", "guide.md");
      assert.deepEqual(
        readFileLastmods([file], path.join(root, "site")),
        new Map([[file, "2026-01-05T00:00:00.000Z"]]),
      );
    });
  }
});
