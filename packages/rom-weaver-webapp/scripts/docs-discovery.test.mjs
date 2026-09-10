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
