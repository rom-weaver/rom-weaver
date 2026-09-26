import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createFirstSampleAssets } from "../../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs";

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    archive: { type: "string" },
    scratch: { type: "string" },
  },
});
for (const name of ["cli", "archive", "scratch"]) {
  assert.ok(values[name], `--${name} is required`);
}
const cli = path.resolve(values.cli);
const archive = path.resolve(values.archive);
const scratch = path.resolve(values.scratch);
assert.ok(!fs.existsSync(scratch), `scratch directory already exists: ${scratch}`);
fs.mkdirSync(scratch, { recursive: true });
const environment = {
  ...process.env,
  ROM_WEAVER_DATA_DIR: path.join(scratch, "data"),
  XDG_CACHE_HOME: path.join(scratch, "cache"),
};
delete environment.DISPLAY;
delete environment.WAYLAND_DISPLAY;
const reports = [];
const run = (args, expectedCode = 0) => {
  const result = spawnSync(cli, ["--json", ...args], {
    cwd: scratch,
    env: environment,
    encoding: "utf8",
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    expectedCode,
    `${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.exit_code, expectedCode);
  reports.push({ args, report });
  return report;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = sha256(fs.readFileSync(archive));
run(["emulator", "install", "--archive", archive, "--sha256", digest]);
run(["emulator", "info"]);
const assets = createFirstSampleAssets();
fs.writeFileSync(path.join(scratch, "original.nes"), assets.originalRom);
fs.writeFileSync(path.join(scratch, "hello-to-rom.ips"), assets.helloToRomPatch);
fs.writeFileSync(path.join(scratch, "sample.zip"), assets.firstCreateZip);
run([
  "patch",
  "apply",
  "--input",
  "original.nes",
  "--patch",
  "hello-to-rom.ips",
  "--output",
  "patched.nes",
  "--no-compress",
]);
assert.deepEqual(fs.readFileSync(path.join(scratch, "patched.nes")), assets.firstPatchResult);

const capture = (rom, screenshot, extra = []) => {
  const report = run(["test", rom, "--frames", "600", "--screenshot", screenshot, ...extra]);
  assert.equal(report.details.status, "smoke-tested");
  assert.equal(report.details.requested_frames, 600);
  const bytes = fs.readFileSync(path.join(scratch, screenshot));
  assert.ok(bytes.length > 100, "screenshot has image content");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(report.details.screenshot_sha256, sha256(bytes));
  return report.details.screenshot_sha256;
};
const original = capture("original.nes", "original.png");
const repeated = capture("original.nes", "repeated.png");
const patched = capture("patched.nes", "patched.png");
const extracted = capture("sample.zip", "extracted.png", ["--select", "hello-world.nes"]);
assert.equal(original, repeated, "repeated runs produce the same frame");
assert.equal(original, extracted, "archive selection runs the same ROM");
assert.notEqual(original, patched, "applying the patch changes the frame");
const preserved = fs.readFileSync(path.join(scratch, "original.png"));
run(["test", "original.nes", "--screenshot", "original.png"], 1);
assert.deepEqual(fs.readFileSync(path.join(scratch, "original.png")), preserved);
fs.writeFileSync(path.join(scratch, "invalid.nes"), "This is not an NES ROM.");
run(["test", "invalid.nes"], 1);
run(["--dry-run", "test", "original.nes", "--screenshot", "dry-run.png"]);
assert.ok(!fs.existsSync(path.join(scratch, "dry-run.png")));
assert.deepEqual(fs.readdirSync(path.join(scratch, "cache", "rom-weaver", "test")), []);
fs.writeFileSync(path.join(scratch, "report.json"), `${JSON.stringify(reports, null, 2)}\n`);
console.log(`Emulator CLI integration passed: ${scratch}`);
console.log(`Original: ${original}\nPatched:  ${patched}`);
