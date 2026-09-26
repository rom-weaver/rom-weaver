import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createFirstSampleAssets } from "../../packages/rom-weaver-webapp/scripts/first-sample-assets.mjs";

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    archive: { type: "string" },
    scratch: { type: "string" },
    "source-dir": { type: "string" },
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
const installed = run(["emulator", "info"]);
const catalog = JSON.parse(
  fs.readFileSync(new URL("../emulator-runtime/sources.json", import.meta.url), "utf8"),
);
assert.deepEqual(
  installed.details.cores.map((core) => core.id).sort(),
  catalog.cores.map((core) => core.id).sort(),
);
const browserLock = JSON.parse(
  fs.readFileSync(
    new URL("../../packages/rom-weaver-webapp/vendor/emulatorjs.lock.json", import.meta.url),
    "utf8",
  ),
);
const browserCores = Object.keys(browserLock.files).flatMap((filename) => {
  const match = /^cores\/(.+)-thread-wasm\.data$/.exec(filename);
  return match ? [match[1]] : [];
});
const nativeCores = new Set(catalog.cores.map((core) => core.id));
assert.equal(nativeCores.size, catalog.cores.length, "native core IDs are unique");
assert.deepEqual(
  browserCores.filter((core) => !nativeCores.has(core)),
  [],
  "native runtime covers every browser core",
);
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

const capture = (rom, screenshot, extra = [], expectedCore) => {
  const report = run(["test", rom, "--frames", "600", "--screenshot", screenshot, ...extra]);
  assert.equal(report.details.status, "smoke-tested");
  assert.equal(report.details.requested_frames, 600);
  if (expectedCore) assert.equal(report.details.core, expectedCore);
  const bytes = fs.readFileSync(path.join(scratch, screenshot));
  assert.ok(bytes.length > 100, "screenshot has image content");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(report.details.screenshot_sha256, sha256(bytes));
  return report.details.screenshot_sha256;
};
const downloadFixture = (filename, url, expectedDigest, maxBytes = 16 * 1024 * 1024) => {
  const destination = path.join(scratch, filename);
  // Upstream test inputs MUST remain outside distributed runtime and source archives.
  const download = spawnSync(
    "curl",
    [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--max-time",
      "60",
      "--max-filesize",
      String(maxBytes),
      "--output",
      destination,
      url,
    ],
    { encoding: "utf8", timeout: 65_000 },
  );
  assert.ifError(download.error);
  assert.equal(download.status, 0, download.stderr);
  assert.equal(sha256(fs.readFileSync(destination)), expectedDigest);
  return destination;
};
const original = capture("original.nes", "original.png");
const repeated = capture("original.nes", "repeated.png");
const patched = capture("patched.nes", "patched.png");
const extracted = capture("sample.zip", "extracted.png", ["--select", "hello-world.nes"]);
assert.equal(original, repeated, "repeated runs produce the same frame");
assert.equal(original, extracted, "archive selection runs the same ROM");
assert.notEqual(original, patched, "applying the patch changes the frame");
if (values["source-dir"]) {
  const source = path.resolve(values["source-dir"]);
  for (const [core, filename] of [
    ["gambatte", "mgba/cinema/gb/acid/dmg-acid2/test.gb"],
    ["mgba", "mgba/cinema/gba/obj/2d-wrap/test.gba"],
  ]) {
    const rom = path.join(source, filename);
    const first = capture(rom, `${core}.png`, ["--core", core]);
    const again = capture(rom, `${core}-again.png`, ["--core", core]);
    assert.equal(first, again, `${core} produces repeatable frames`);
    assert.notEqual(first, original, `${core} renders its own content`);
  }
  const ds = new URL("../../tests/fixtures/trim/nds-downloadplay.input.nds", import.meta.url);
  capture(fileURLToPath(ds), "melonds.png", ["--core", "melonds"]);
  const fixtureRevision = "2c804f5cb3cd97b5ca3e11242060fee73e50bc47";
  const fixtureUrl = `https://raw.githubusercontent.com/hrydgard/pspautotests/${fixtureRevision}/tests/gpu/complex/complex.prx`;
  const psp = downloadFixture(
    "complex.prx",
    fixtureUrl,
    "c7fe00619e634b23042828836390c5e8812579b0b1f290864b64e37919a84e71",
    1024 * 1024,
  );
  capture(psp, "ppsspp.png", ["--core", "ppsspp"]);
  run(["test", psp, "--core", "ppsspp", "--frames", "1"]);
  const fixtures = JSON.parse(
    fs.readFileSync(new URL("./emulator-fixtures.json", import.meta.url), "utf8"),
  );
  for (const fixture of fixtures) {
    const input = downloadFixture(fixture.filename, fixture.url, fixture.sha256);
    const extra = ["--core", fixture.core];
    let rom = input;
    if (fixture.select) {
      extra.push("--select", fixture.select);
      const output = path.join(scratch, `${fixture.core}-extracted`);
      run(["extract", "--input", input, "--output", output, "--select", fixture.select]);
      rom = path.join(output, fixture.select);
    }
    if (fixture.extension) {
      const renamed = path.join(scratch, `${fixture.core}.${fixture.extension}`);
      fs.copyFileSync(rom, renamed);
      rom = renamed;
    }
    const selected = capture(input, `${fixture.core}.png`, extra, fixture.core);
    const automatic = capture(rom, `${fixture.core}-auto.png`, [], fixture.core);
    assert.equal(selected, automatic, `${fixture.core} selection produces the same frame`);
  }
}
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
