#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const log = (message) => process.stdout.write(`[parity] ${message}\n`);
const section = (title) => process.stdout.write(`\n[parity] === ${title} ===\n`);
const fail = (message) => { throw new Error(message); };
const sha1 = (file) => createHash("sha1").update(readFileSync(file)).digest("hex");
// stdout and stderr are discarded, never the diagnostics: a tool that fails
// has to be able to say why, so its stderr always reaches the log.
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "ignore", "inherit"], ...options });
// Both streams, as the shell's `2>&1` captured: the tools split their progress
// and result lines across them, and a check that greps only stdout would report
// a missing result line as a codec regression.
function combinedOutput(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: Infinity });
  if (result.error) fail(`${command} could not be run: ${result.error.message}`);
  return { text: `${result.stdout || ""}${result.stderr || ""}`, status: result.status };
}
const same = (left, right) => readFileSync(left).equals(readFileSync(right));

export function generateFixture(path, size, gamecube = false) {
  const buffer = Buffer.alloc(gamecube ? 0x440 + size : size);
  if (gamecube) {
    buffer.write("RWTEST", 0);
    buffer.writeUInt32BE(0xc2339f3d, 0x1c);
    buffer.write("rom-weaver-test\0", 0x20);
    for (let i = 0x440; i < buffer.length; i += 1) buffer[i] = (i - 0x440) % 251;
  } else {
    for (let i = 0; i < size; i += 1) buffer[i] = ((Math.floor(i / 64) + (i % 17)) & 0xff);
  }
  writeFileSync(path, buffer);
}

function requireTool(label, bin) {
  const result = spawnSync(bin, ["--help"], { stdio: "ignore" });
  if (result.error && !existsSync(bin)) fail(`${label} binary not found: '${bin}' (set ${label}_BIN or install it)`);
}

function extractOne(binary, source, output) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  run(binary, ["extract", "--input", source, "--output", output, "--json"]);
}

function reportExtract(path, source, label) {
  if (!existsSync(path)) { log(`ERROR: ${label} produced no expected output`); return 1; }
  if (same(path, source)) { log(`OK: ${label} is byte-identical to the source`); return 0; }
  log(`ERROR: ${label} differs from source (sha1 want=${sha1(source)} got=${sha1(path)})`);
  return 1;
}

export function runParity({ root = process.cwd(), env = process.env } = {}) {
  const profile = env.PARITY_CARGO_PROFILE || "debug";
  if (!["debug", "release"].includes(profile)) fail(`PARITY_CARGO_PROFILE must be 'debug' or 'release' (got: ${profile})`);
  const chdman = env.CHDMAN_BIN || "chdman";
  const dolphin = env.DOLPHIN_TOOL_BIN || "dolphin-tool";
  requireTool("CHDMAN", chdman);
  requireTool("DOLPHIN_TOOL", dolphin);
  const cli = env.ROM_WEAVER_BIN || join(root, "target", profile, "rom-weaver");
  if (!env.ROM_WEAVER_BIN && !existsSync(cli)) {
    log(`building rom-weaver CLI (${profile} profile)`);
    run("cargo", ["build", "--manifest-path", join(root, "Cargo.toml"), ...(profile === "release" ? ["--release"] : []), "-p", "rom-weaver-cli"]);
  }
  if (!existsSync(cli)) fail(`rom-weaver CLI not found/executable at: ${cli}`);
  log(`rom-weaver: ${cli}`);
  log(`chdman:     ${chdman}`);
  log(`dolphin:    ${dolphin}`);

  const workRoot = join(root, "target/parity-check");
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  log(`workspace: ${workRoot}`);
  let failures = 0;

  section("CHD createhd parity vs chdman");
  const chdDir = join(workRoot, "chd");
  mkdirSync(chdDir);
  const chdSource = join(chdDir, "disc.img");
  generateFixture(chdSource, 4 * 1024 * 1024);
  const sourceSha = sha1(chdSource);
  log(`fixture disc.img sha1=${sourceSha} (${readFileSync(chdSource).length} bytes)`);
  const rwChd = join(chdDir, "rw.chd");
  run(cli, ["compress", "--input", chdSource, "--format", "chd", "--output", rwChd, "--threads", "1", "--json"]);
  const verify = combinedOutput(chdman, ["verify", "-i", rwChd]);
  if (verify.status !== 0) { process.stdout.write(verify.text); fail("chdman could not parse/verify rom-weaver's CHD"); }
  for (const kind of ["Raw", "Overall"]) {
    if (new RegExp(`${kind} SHA1 verification successful`, "i").test(verify.text)) continue;
    process.stdout.write(verify.text);
    fail(`chdman ${kind} SHA1 verification did NOT succeed on rom-weaver's CHD (codec output regression?)`);
  }
  log("chdman verify: Raw SHA1 + Overall SHA1 OK");
  const chdExtract = join(chdDir, "rw-extract.img");
  run(chdman, ["extracthd", "-f", "-i", rwChd, "-o", chdExtract], { stdio: "ignore" });
  failures += reportExtract(chdExtract, chdSource, "chdman-extracted rom-weaver CHD");
  const referenceChd = join(chdDir, "ref.chd");
  run(chdman, ["createhd", "-f", "-np", "1", "-i", chdSource, "-o", referenceChd], { stdio: "ignore" });
  const refExtractDir = join(chdDir, "ref-extract");
  extractOne(cli, referenceChd, refExtractDir);
  failures += reportExtract(join(refExtractDir, "ref.img"), chdSource, "rom-weaver-extracted chdman CHD");
  const rwOverall = readFileSync(rwChd).subarray(84, 104).toString("hex");
  const refOverall = readFileSync(referenceChd).subarray(84, 104).toString("hex");
  const rwRaw = readFileSync(rwChd).subarray(64, 84).toString("hex");
  const refRaw = readFileSync(referenceChd).subarray(64, 84).toString("hex");
  if (rwRaw !== refRaw || rwOverall !== refOverall) { log("ERROR: CHD header SHA1 mismatch vs chdman"); failures += 1; }

  section("RVZ round-trip parity vs dolphin-tool");
  const rvzDir = join(workRoot, "rvz");
  const dolphinUser = join(rvzDir, "dolphin-user");
  mkdirSync(dolphinUser, { recursive: true });
  const rvzSource = join(rvzDir, "disc.iso");
  generateFixture(rvzSource, 4 * 1024 * 1024, true);
  const rwRvz = join(rvzDir, "rw.rvz");
  run(cli, ["compress", "--input", rvzSource, "--format", "rvz", "--output", rwRvz, "--codec", "zstd", "--threads", "1", "--json"]);
  const roundtrip = join(rvzDir, "rw-roundtrip.iso");
  runDolphin(dolphin, dolphinUser, rwRvz, roundtrip, "iso");
  failures += reportExtract(roundtrip, rvzSource, "dolphin-tool-extracted rom-weaver RVZ");
  const referenceRvz = join(rvzDir, "ref.rvz");
  runDolphin(dolphin, dolphinUser, rvzSource, referenceRvz, "rvz", ["-c", "zstd", "-l", "5", "-b", "131072"]);
  const rvzExtractDir = join(rvzDir, "ref-extract");
  extractOne(cli, referenceRvz, rvzExtractDir);
  failures += reportExtract(join(rvzExtractDir, "ref.iso"), rvzSource, "rom-weaver-extracted dolphin-tool RVZ");
  if (failures) fail(`${failures} parity check(s) FAILED -- a vendored codec may have regressed`);
  log("all parity checks PASSED (CHD vs chdman, RVZ round-trip vs dolphin-tool)");
}

function runDolphin(bin, user, input, output, format, extra = []) {
  const args = ["convert", "-u", user, "-i", input, "-o", output, "-f", format, ...extra];
  const result = combinedOutput(bin, args);
  // macOS dolphin-tool chatters a "bundle id" line on every invocation; it is
  // noise, not a finding.
  const text = result.text.replace(/^.*bundle id.*$/gim, "");
  if (text.trim()) process.stdout.write(text);
  // Checked, not inferred from a missing file: a converter that fails loudly
  // should say so here rather than surface as an unexplained absent output.
  if (result.status !== 0) fail(`dolphin-tool ${args.join(" ")} exited with status ${result.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runParity(); } catch (error) { process.stderr.write(`[parity] FAIL: ${error.message}\n`); process.exitCode = 1; }
}
