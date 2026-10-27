import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readNoticesLastmod } from "./notices-lastmod.mjs";

const page = (text) => `const WEBAPP_NOTICES_PAGE = \`# Notices\n\n${text}\n\`;\nconst OTHER = 1;\n`;

const makeRepository = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notices-lastmod-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: directory,
      stdio: "ignore",
    });
  const generator = path.join(directory, "scripts/gen-third-party-licenses.mjs");
  fs.mkdirSync(path.dirname(generator), { recursive: true });
  git("init");
  const release = (version, text, extra = "") => {
    fs.writeFileSync(generator, `${page(text)}${extra}`);
    git("add", ".");
    git("commit", "-m", `release ${version}`, "--allow-empty");
    git("tag", `v${version}`);
  };
  const changelog = path.join(directory, "CHANGELOG.md");
  fs.writeFileSync(
    changelog,
    [
      "## [1.3.0](x) (2026-04-01)",
      "## [1.2.0](x) (2026-03-01)",
      "## [1.1.0](x) (2026-02-01)",
      "## [1.0.0](x) (2026-01-01)",
      "",
    ].join("\n"),
  );
  return { changelog, directory, generator, git, release };
};

test("the date is the oldest release whose Notices text equals the current one", (context) => {
  const { changelog, directory, release } = makeRepository(context);
  release("1.0.0", "old");
  release("1.1.0", "new");
  release("1.2.0", "new", "// unrelated generator change\n");
  release("1.3.0", "new");
  assert.equal(readNoticesLastmod(directory, changelog), "2026-02-01");
});

test("a release with an unchanged page leaves the date alone", (context) => {
  const { changelog, directory, release } = makeRepository(context);
  release("1.0.0", "same");
  release("1.1.0", "same");
  release("1.2.0", "same");
  assert.equal(readNoticesLastmod(directory, changelog), "2026-01-01");
});

test("no date when the page changed since the newest release, or history is unusable", (context) => {
  const { changelog, directory, generator, release } = makeRepository(context);
  release("1.0.0", "old");
  fs.writeFileSync(generator, page("unreleased"));
  assert.equal(readNoticesLastmod(directory, changelog), null);
  assert.equal(readNoticesLastmod(path.join(directory, "missing"), changelog), null);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "notices-lastmod-bare-"));
  context.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(readNoticesLastmod(bare, changelog), null);
});

test("no date from a shallow clone, which cannot show earlier releases", (context) => {
  const { changelog, directory, release } = makeRepository(context);
  release("1.0.0", "page");
  release("1.1.0", "page");
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "notices-lastmod-shallow-"));
  context.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  execFileSync("git", ["clone", "--depth=1", `file://${directory}`, path.join(shallow, "clone")], { stdio: "ignore" });
  assert.equal(readNoticesLastmod(path.join(shallow, "clone"), changelog), null);
});

test("no date when the oldest matching release has no changelog entry", (context) => {
  const { directory, release } = makeRepository(context);
  release("9.9.9", "page");
  assert.equal(readNoticesLastmod(directory, path.join(directory, "CHANGELOG.md")), null);
});
