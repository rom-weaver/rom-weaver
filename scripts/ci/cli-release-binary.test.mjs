import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { elf, pe } from "./binary-fixtures.mjs";
import { main, pack, verify } from "./cli-release-binary.mjs";

const TREE = "a".repeat(40);
const SOURCE = "b".repeat(40);
const REPOSITORY = "rom-weaver/rom-weaver";

// A staged platform package as build-cli-platform leaves it, plus the identify tree the release builds itself.
function fixture(platform = { name: "linux-x64-gnu", target: "x86_64-unknown-linux-gnu", binary: "rom-weaver", bytes: elf({ arch: "x86_64", interpreter: "/lib64/ld-linux-x86-64.so.2" }) }) {
  const root = mkdtempSync(join(tmpdir(), "rom-weaver-release-binary-"));
  const directory = join(root, "ci", "packages", "rom-weaver-cli-platforms", platform.name);
  mkdirSync(join(directory, "bin"), { recursive: true });
  mkdirSync(join(directory, "share", "identify"), { recursive: true });
  mkdirSync(join(directory, "third_party", "licenses"), { recursive: true });
  writeFileSync(join(directory, "bin", platform.binary), platform.bytes);
  chmodSync(join(directory, "bin", platform.binary), 0o755);
  writeFileSync(join(directory, "package.json"), '{"name":"@rom-weaver/test"}\n');
  writeFileSync(join(directory, "LICENSE"), "license\n");
  writeFileSync(join(directory, "CLI_NOTICE"), "notice\n");
  writeFileSync(join(directory, "third_party", "licenses", "a.txt"), "a\n");
  writeFileSync(join(directory, "share", "identify", "ci-only"), "must not travel\n");
  const releaseShare = join(root, "release", "target", "identify-release", "share", "identify");
  mkdirSync(releaseShare, { recursive: true });
  writeFileSync(join(releaseShare, "index"), "release identify tree\n");
  mkdirSync(join(root, "release", "packages", "rom-weaver-cli-platforms", platform.name), { recursive: true });
  const options = { name: platform.name, target: platform.target, binary: platform.binary, tree: TREE, repository: REPOSITORY };
  const out = join(root, "artifact");
  const packed = () =>
    pack({ ...options, root: join(root, "ci"), sourceSha: SOURCE, runId: "123", runAttempt: "1", out });
  return { root, options, out, packed, platform };
}

test("packs the binary alone and records its hash", () => {
  const { root, packed, out } = fixture();
  try {
    const manifest = packed();
    // package.json, licenses, notices, and the identify tree never travel: the release stages them
    // from its own checkout, so only the attested binary comes from CI.
    assert.deepEqual(Object.keys(manifest.files), ["bin/rom-weaver"]);
    assert.deepEqual(readdirSync(join(out, "package")), ["bin"]);
    assert.deepEqual(readdirSync(join(out, "package/bin")), ["rom-weaver"]);
    assert.equal(manifest.files["bin/rom-weaver"], createHash("sha256").update(readFileSync(join(out, "package/bin/rom-weaver"))).digest("hex"));
    assert.equal(manifest.tree, TREE);
    assert.equal(manifest.sourceSha, SOURCE);
    assert.equal(manifest.runId, "123");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an artifact for another tree, package, target, repository, or binary name", () => {
  const { root, packed, out, options } = fixture();
  try {
    packed();
    for (const [key, value] of [
      ["tree", "c".repeat(40)],
      ["name", "linux-x64-musl"],
      ["target", "x86_64-unknown-linux-musl"],
      ["repository", "someone/else"],
      ["binary", "rom-weaver.exe"],
    ])
      assert.throws(() => verify({ dir: out, ...options, [key]: value }), /build\.json/, key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a changed, added, or removed file", () => {
  for (const tamper of [
    (out) => writeFileSync(join(out, "package/bin/rom-weaver"), "tampered"),
    (out) => writeFileSync(join(out, "package/extra"), "extra"),
    // A package.json could carry install scripts; the artifact may hold nothing but the binary.
    (out) => writeFileSync(join(out, "package/package.json"), '{"scripts":{"postinstall":"x"}}\n'),
    (out) => {
      writeFileSync(join(out, "package/package.json"), "{}\n");
      const manifest = JSON.parse(readFileSync(join(out, "build.json"), "utf8"));
      manifest.files["package.json"] = createHash("sha256").update("{}\n").digest("hex");
      writeFileSync(join(out, "build.json"), JSON.stringify(manifest));
    },
    (out) => rmSync(join(out, "package/bin/rom-weaver")),
  ]) {
    const { root, packed, out, options } = fixture();
    try {
      packed();
      tamper(out);
      assert.throws(() => verify({ dir: out, ...options }), /differ from build\.json|does not match|ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("refuses a binary built for a different target even when its hashes match", () => {
  // The artifact is internally consistent, so only the header check can catch the swap.
  const { root, packed, out, options } = fixture({ name: "win32-x64-msvc", target: "x86_64-pc-windows-msvc", binary: "rom-weaver.exe", bytes: pe(0x8664) });
  const wrong = fixture({ name: "win32-x64-msvc", target: "x86_64-pc-windows-msvc", binary: "rom-weaver.exe", bytes: pe(0xaa64) });
  try {
    packed();
    verify({ dir: out, ...options });
    wrong.packed();
    assert.throws(() => verify({ dir: wrong.out, ...wrong.options }), /arch aarch64, not x86_64/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wrong.root, { recursive: true, force: true });
  }
});

test("refuses an artifact without a staged binary", () => {
  const { root, options, out } = fixture();
  try {
    rmSync(join(root, "ci/packages/rom-weaver-cli-platforms", options.name, "bin"), { recursive: true });
    assert.throws(() => pack({ ...options, root: join(root, "ci"), sourceSha: SOURCE, runId: "1", runAttempt: "1", out }), /no staged bin\/rom-weaver/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command line packs and verifies with the workflow's flags", () => {
  const { root, out, options } = fixture();
  try {
    const flags = ["--package", options.name, "--target", options.target, "--binary", options.binary, "--tree", TREE, "--repository", REPOSITORY];
    const packed = main(["pack", ...flags, "--root", join(root, "ci"), "--source-sha", SOURCE, "--run-id", "9", "--run-attempt", "2", "--out", out], {});
    assert.equal(packed.runAttempt, "2");
    assert.equal(main(["verify", ...flags, "--dir", out], {}).package, options.name);
    assert.throws(() => main(["install", "--package", options.name, "--dir", out], {}), /usage/);
    assert.throws(() => main(["unpack"], {}), /usage/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a symlink in place of the binary", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const { root, packed, out, options } = fixture();
  try {
    packed();
    rmSync(join(out, "package/bin/rom-weaver"));
    symlinkSync("/bin/sh", join(out, "package/bin/rom-weaver"));
    assert.throws(() => verify({ dir: out, ...options }), /not a regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
