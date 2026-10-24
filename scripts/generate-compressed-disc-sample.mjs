import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.resolve(process.argv[2] ?? path.join(root, "target/debug/rom-weaver"));
const fixture = path.join(
  root,
  "packages/rom-weaver-webapp/tests/fixtures/browser-generated/game-cd.chd",
);
const destination = path.join(root, "docs/samples/compressed-disc");
const scratchRoot = path.join(root, ".agent");
execFileSync("git", ["check-ignore", "--quiet", scratchRoot], { cwd: root });
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "compressed-disc-sample-"));
const run = (...args) => execFileSync(cli, args, { cwd: root, stdio: "inherit" });
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

try {
  run("extract", "--input", fixture, "--output", path.join(scratch, "source"));
  const original = path.join(scratch, "source/game-cd.bin");
  const bytes = readFileSync(original);
  assert.equal(bytes.length, 32768);
  assert.equal(sha1(bytes), "ba1af47af57aed5590c30358f4b7dc247cf26e94");
  const first = Buffer.from(bytes);
  first.write("FIRST PATCH DONE", 1024, "ascii");
  const second = Buffer.from(first);
  second.write("BOTH PATCHES OK!", 1024, "ascii");
  assert.equal(sha1(first), "b94e0943f9d487bb1a8961dfdce4494bf83d2160");
  assert.equal(sha1(second), "ebce631d802abe7c450e3f6cb658f9679701fdd6");
  const intermediate = path.join(scratch, "first.bin");
  const final = path.join(scratch, "second.bin");
  writeFileSync(intermediate, first);
  writeFileSync(final, second);
  const patch1 = path.join(scratch, "01-first.bps");
  const patch2 = path.join(scratch, "02-second.bps");
  run(
    "patch",
    "create",
    "--original",
    original,
    "--modified",
    intermediate,
    "--format",
    "bps",
    "--output",
    patch1,
  );
  run(
    "patch",
    "create",
    "--original",
    intermediate,
    "--modified",
    final,
    "--format",
    "bps",
    "--output",
    patch2,
  );
  const output = path.join(scratch, "patched.chd");
  run(
    "patch",
    "apply",
    "--input",
    fixture,
    "--select",
    "*.bin",
    "--patch",
    patch1,
    "--patch",
    patch2,
    "--output",
    output,
  );
  run("extract", "--input", output, "--output", path.join(scratch, "result"));
  assert.deepEqual(readFileSync(path.join(scratch, "result/patched.bin")), second);
  mkdirSync(destination, { recursive: true });
  copyFileSync(fixture, path.join(destination, "practice-disc.chd"));
  copyFileSync(patch1, path.join(destination, "01-first.bps"));
  copyFileSync(patch2, path.join(destination, "02-second.bps"));
  console.log(`Verified sample files written to ${destination}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
