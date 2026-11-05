import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { resolveNpmCli, restoreExecutableMode } from "./npm-publish-package.mjs";

test("restores executable mode before publishing binary packages", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-npm-publish-"));
  try {
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    writeFileSync(join(binDirectory, "rom-weaver"), "binary");
    chmodSync(join(binDirectory, "rom-weaver"), 0o644);

    restoreExecutableMode(directory, { bin: { "rom-weaver": "bin/rom-weaver" } });

    assert.equal(statSync(join(binDirectory, "rom-weaver")).mode & 0o777, 0o755);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const scratch = () => mkdtempSync(join(tmpdir(), "rom-weaver-npm-cli-"));

test("finds npm-cli.js through the symlinked npm of a Linux or macOS install", { skip: process.platform === "win32" }, () => {
  const directory = scratch();
  try {
    const cli = join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(directory, "lib", "node_modules", "npm", "bin"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    writeFileSync(cli, "");
    symlinkSync(cli, join(directory, "bin", "npm"));
    assert.equal(realpathSync(resolveNpmCli({ env: { PATH: `/nonexistent${delimiter}${join(directory, "bin")}` } })), realpathSync(cli));
    // A wrapper script that is not npm-cli.js must not be mistaken for it.
    writeFileSync(join(directory, "npm"), "#!/bin/sh\n");
    assert.throws(() => resolveNpmCli({ env: { PATH: directory } }), /cannot find npm-cli\.js/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("finds npm-cli.js beside npm.cmd in a Windows install, without spawning the shim", () => {
  const install = join("win", "node");
  const present = new Set([join(install, "npm.cmd"), join(install, "node_modules", "npm", "bin", "npm-cli.js")]);
  const exists = (path) => present.has(path);
  const env = { PATH: [join("win", "other"), install].join(delimiter) };
  assert.equal(resolveNpmCli({ env, platform: "win32", exists }), join(install, "node_modules", "npm", "bin", "npm-cli.js"));
  assert.throws(() => resolveNpmCli({ env: { PATH: join("win", "other") }, platform: "win32", exists }), /cannot find npm-cli\.js/);
  // A directory with npm.cmd but no bundled npm (a shim elsewhere) is not guessed at.
  present.delete(join(install, "node_modules", "npm", "bin", "npm-cli.js"));
  assert.throws(() => resolveNpmCli({ env, platform: "win32", exists }), /cannot find npm-cli\.js/);
});

test("prefers the npm that is running this script", () => {
  const directory = scratch();
  try {
    const cli = join(directory, "npm-cli.js");
    writeFileSync(cli, "");
    assert.equal(resolveNpmCli({ env: { npm_execpath: cli, PATH: "" } }), cli);
    assert.throws(() => resolveNpmCli({ env: { npm_execpath: join(directory, "yarn.js"), PATH: "" } }), /cannot find/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// Runs the real script with a fake npm-cli.js that records its arguments, from a directory with no
// node_modules, so the publish path cannot depend on any installed package.
function publish({ args, viewStatus = 1, publishStatus = 0 }) {
  const directory = scratch();
  try {
    const cli = join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(directory, "lib", "node_modules", "npm", "bin"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    mkdirSync(join(directory, "pkg"));
    writeFileSync(join(directory, "pkg", "package.json"), JSON.stringify({ name: "@rom-weaver/test", version: "1.2.3-beta.1", bin: { "rom-weaver": "bin/rom-weaver" } }));
    mkdirSync(join(directory, "pkg", "bin"));
    writeFileSync(join(directory, "pkg", "bin", "rom-weaver"), "binary");
    writeFileSync(cli, `require("fs").appendFileSync(${JSON.stringify(join(directory, "calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n"); process.exit(process.argv[2] === "view" ? ${viewStatus} : ${publishStatus});`);
    symlinkSync(cli, join(directory, "bin", "npm"));
    mkdirSync(join(directory, "script"));
    copyFileSync(new URL("./npm-publish-package.mjs", import.meta.url), join(directory, "script", "npm-publish-package.mjs"));
    const result = spawnSync(process.execPath, [join(directory, "script", "npm-publish-package.mjs"), ...args, join(directory, "pkg")], {
      encoding: "utf8",
      env: { PATH: `${join(directory, "bin")}${delimiter}${process.env.PATH}`, HOME: directory },
    });
    const calls = existsSync(join(directory, "calls")) ? readFileSync(join(directory, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { status: result.status, output: result.stdout + result.stderr, calls, directory, mode: statSync(join(directory, "pkg", "bin", "rom-weaver")).mode & 0o777 };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("publishes through npm-cli.js with provenance and the prerelease tag", { skip: process.platform === "win32" }, () => {
  const result = publish({ args: [] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.map((call) => call[0]), ["view", "publish"]);
  assert.deepEqual(result.calls[0], ["view", "@rom-weaver/test@1.2.3-beta.1", "version"]);
  assert.deepEqual(result.calls[1].slice(2), ["--ignore-scripts", "--access", "public", "--provenance", "--tag", "beta"]);
  assert.equal(result.mode, 0o755);
});

test("a dry run never checks the registry or uses provenance", { skip: process.platform === "win32" }, () => {
  const result = publish({ args: ["--dry-run"] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.map((call) => call[0]), ["publish"]);
  assert.ok(result.calls[0].includes("--dry-run"));
  assert.ok(!result.calls[0].includes("--provenance"));
});

test("an already published version is accepted and a failed publish is not", { skip: process.platform === "win32" }, () => {
  const published = publish({ args: [], viewStatus: 0 });
  assert.equal(published.status, 0, published.output);
  assert.match(published.output, /already published/);
  assert.deepEqual(published.calls.map((call) => call[0]), ["view"]);
  const failed = publish({ args: [], publishStatus: 1 });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /failed to publish @rom-weaver\/test@1\.2\.3-beta\.1/);
});
