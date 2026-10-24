import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runVendor } from "./vendor-dependencies.mjs";
import { QUEUE_ROOT } from "./vendor/manifest.mjs";
import { sha256 } from "./vendor/tree.mjs";

const patch = (before = "original", after = "fixed") => `diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-${before}
+${after}
`;

function fixture(t, { materialized = true, extraFiles = false } = {}) {
  const scratch = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "agents/scratch/vendor-queue-tests",
  );
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "archive/upstream/src");
  const cache = join(root, "cache");
  const queue = join(root, QUEUE_ROOT, "nod");
  const destination = join(root, "crates/rom-weaver-containers/src/nod");
  for (const directory of [
    source,
    cache,
    queue,
    destination,
    join(root, "home"),
    join(root, "config"),
  ])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(source, "value.txt"), "original\n");
  writeFileSync(join(root, "archive/upstream/LICENSE"), "license\n");
  const archive = join(root, "source.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "archive"), "upstream"], {
    env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
  });
  const digest = sha256(readFileSync(archive));
  writeFileSync(join(cache, `${digest}.tar.gz`), readFileSync(archive));
  const manifest = {
    version: 1,
    name: "nod",
    source: {
      url: "https://example.invalid/source.tar.gz",
      revision: "pinned",
      sha256: digest,
      format: "tar",
      root: "upstream/src",
    },
    destination: "crates/rom-weaver-containers/src/nod",
    materialized,
    preserve: ["VERSION"],
    patches: [
      {
        file: "fix.patch",
        stage: "source",
        reason: "Keep the fixed behavior",
        upstream: { status: "not-submitted" },
        tests: ["fixture regression"],
      },
    ],
  };
  if (extraFiles) manifest.source.extraFiles = [{ from: "upstream/LICENSE", to: "LICENSE" }];
  const save = () => writeFileSync(join(queue, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  save();
  writeFileSync(join(queue, "fix.patch"), patch());
  writeFileSync(join(destination, "value.txt"), materialized ? "fixed\n" : "original\n");
  writeFileSync(join(destination, "VERSION"), "metadata stays\n");
  if (extraFiles) writeFileSync(join(destination, "LICENSE"), "license\n");
  const messages = [];
  const options = {
    root,
    command: "check",
    name: "nod",
    offline: true,
    cache,
    backupRoot: join(root, "backups"),
    log: (line) => messages.push(line),
  };
  return { root, queue, destination, manifest, save, options, messages, cache, digest };
}

test("list explains patches without fetching or needing a cache", async (t) => {
  const f = fixture(t);
  await runVendor({ ...f.options, command: "list", cache: join(f.root, "not-created") });
  assert.equal(existsSync(join(f.root, "not-created")), false);
  assert.match(f.messages.join("\n"), /fix.patch \[source; not-submitted\]/);
});

test("replay reproduces materialized Rust sources and copied upstream licenses", async (t) => {
  const f = fixture(t, { extraFiles: true });
  assert.equal((await runVendor(f.options))[0].changed, 0);
  assert.match(f.messages[0], /verified 1 patches/);
});

test("check detects changed, missing, and unexpected source files", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.destination, "value.txt"), "unrecorded edit\n");
  writeFileSync(join(f.destination, "unexpected.txt"), "new file\n");
  await assert.rejects(
    runVendor(f.options),
    /unexplained vendor drift[\s\S]*unexpected unexpected.txt[\s\S]*changed value.txt/,
  );
  rmSync(join(f.destination, "value.txt"));
  await assert.rejects(runVendor(f.options), /missing value.txt/);
  rmSync(join(f.destination, "unexpected.txt"));
  writeFileSync(join(f.destination, "value.txt"), "fixed\n");
  assert.equal((await runVendor(f.options))[0].changed, 0);
});

test("incompatible patch blocks refresh before changing the destination", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.queue, "fix.patch"), patch("wrong context"));
  await assert.rejects(runVendor({ ...f.options, command: "refresh" }), /fix.patch conflicts/);
  assert.equal(readFileSync(join(f.destination, "value.txt"), "utf8"), "fixed\n");
  assert.equal(existsSync(f.options.backupRoot), false);
});

test("mail patch preambles fail verification before refreshing C sources", async (t) => {
  const f = fixture(t, { materialized: false });
  writeFileSync(
    join(f.queue, "fix.patch"),
    `From: Contributor <dev@example.invalid>\nSubject: Fix\n\n${patch()}`,
  );
  for (const command of ["check", "refresh"]) {
    await assert.rejects(
      runVendor({ ...f.options, command }),
      /patch MUST begin with a diff --git header/,
    );
  }
  assert.equal(readFileSync(join(f.destination, "value.txt"), "utf8"), "original\n");
  assert.equal(existsSync(f.options.backupRoot), false);
});

test("refresh backs up originals, retains metadata, and then passes check", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.destination, "value.txt"), "old custom value\n");
  const [result] = await runVendor({ ...f.options, command: "refresh" });
  assert.equal(readFileSync(join(result.backup, "value.txt"), "utf8"), "old custom value\n");
  assert.equal(readFileSync(join(f.destination, "value.txt"), "utf8"), "fixed\n");
  assert.equal(readFileSync(join(f.destination, "VERSION"), "utf8"), "metadata stays\n");
  assert.equal((await runVendor(f.options))[0].changed, 0);
  assert.equal((await runVendor({ ...f.options, command: "refresh" }))[0].backup, null);
});

test("pristine C snapshots stay pristine while target patches are checked", async (t) => {
  const f = fixture(t, { materialized: false });
  f.manifest.patches.push({ ...f.manifest.patches[0], file: "wasm.patch", stage: "wasm" });
  f.save();
  writeFileSync(join(f.queue, "wasm.patch"), patch("fixed", "wasm"));
  assert.equal((await runVendor(f.options))[0].patches, 2);
  assert.equal(readFileSync(join(f.destination, "value.txt"), "utf8"), "original\n");
  writeFileSync(join(f.queue, "wasm.patch"), patch("wrong", "wasm"));
  await assert.rejects(runVendor(f.options), /wasm.patch conflicts/);
});

test("patch order matters and add/delete operations reproduce the tree", async (t) => {
  const f = fixture(t);
  f.manifest.patches.push({
    ...f.manifest.patches[0],
    file: "integration.patch",
    stage: "integration",
  });
  f.save();
  writeFileSync(
    join(f.queue, "integration.patch"),
    `diff --git a/value.txt b/value.txt
deleted file mode 100644
--- a/value.txt
+++ /dev/null
@@ -1 +0,0 @@
-fixed
diff --git a/module.txt b/module.txt
new file mode 100644
--- /dev/null
+++ b/module.txt
@@ -0,0 +1 @@
+integrated
`,
  );
  rmSync(join(f.destination, "value.txt"));
  writeFileSync(join(f.destination, "module.txt"), "integrated\n");
  assert.equal((await runVendor(f.options))[0].changed, 0);
  f.manifest.patches.reverse();
  f.save();
  await assert.rejects(runVendor(f.options), /integration.patch conflicts/);
});

test("cached archive tampering fails checksum verification", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cache, `${f.digest}.tar.gz`), "corrupted archive");
  await assert.rejects(runVendor(f.options), /cached source SHA-256 mismatch/);
});

test("conflict inspection retains pristine and partially replayed source on request", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.queue, "fix.patch"), patch("wrong context"));
  await assert.rejects(runVendor({ ...f.options, keepWork: true }), /fix.patch conflicts/);
  const retained = f.messages
    .find((line) => line.startsWith("replay files: "))
    .slice("replay files: ".length);
  assert.equal(readFileSync(join(retained, "nod/pristine/value.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(retained, "nod/patched/value.txt"), "utf8"), "original\n");
});

test("offline check reports an uncached archive without attempting downloads", async (t) => {
  const f = fixture(t);
  rmSync(join(f.cache, `${f.digest}.tar.gz`));
  await assert.rejects(runVendor(f.options), /source archive is not cached/);
});

test("unsafe manifest and patch paths cannot reach outside their source root", async (t) => {
  const f = fixture(t);
  const safeDestination = f.manifest.destination;
  f.manifest.destination = "../escape";
  f.save();
  await assert.rejects(runVendor(f.options), /Unsafe relative path/);
  f.manifest.destination = safeDestination;
  f.save();
  writeFileSync(join(f.queue, "fix.patch"), patch().replaceAll("value.txt", "../escape"));
  await assert.rejects(runVendor(f.options), /Unsafe relative path/);
  assert.equal(existsSync(join(dirname(f.root), "escape")), false);
});

test("a source symlink cannot redirect refresh writes", async (t) => {
  const f = fixture(t);
  rmSync(join(f.destination, "value.txt"));
  const outside = join(f.root, "outside.txt");
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, join(f.destination, "value.txt"));
  await assert.rejects(runVendor({ ...f.options, command: "refresh" }), /Refusing symbolic link/);
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
});
