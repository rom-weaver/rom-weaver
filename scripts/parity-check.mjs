#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
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

// A lookup, not an execution: the shell's `command -v "$bin" || [ -x "$bin" ]`.
// Running `--help` to prove a tool exists takes an opinion on a flag the tool
// need not support, and it treats "present but not executable" as present.
export function findTool(bin, env = process.env, exists = (path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }) {
  if (bin.includes("/")) return exists(bin) ? bin : "";
  for (const directory of (env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, bin);
    if (exists(candidate)) return candidate;
  }
  return "";
}

function requireTool(label, bin, env) {
  if (!findTool(bin, env)) fail(`${label} binary not found: '${bin}' (set ${label}_BIN or install it; e.g. npm i -g chdman dolphin-tool)`);
}

function extractOne(binary, source, output) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  run(binary, ["extract", "--input", source, "--output", output, "--json"]);
}

function reportExtract(path, source, label) {
  if (!existsSync(path)) {
    // What the extractor DID emit: rom-weaver names its output from the source
    // basename, so a rename upstream looks identical to producing nothing.
    const directory = dirname(path);
    const got = existsSync(directory) ? readdirSync(directory).join(" ") || "(empty)" : "(no output directory)";
    log(`ERROR: ${label} produced no ${basename(path)}; got: ${got}`);
    return 1;
  }
  if (same(path, source)) { log(`OK: ${label} is byte-identical to the source`); return 0; }
  log(`ERROR: ${label} differs from source (sha1 want=${sha1(source)} got=${sha1(path)})`);
  return 1;
}

export function runParity({ root = process.cwd(), env = process.env } = {}) {
  const profile = env.PARITY_CARGO_PROFILE || "debug";
  if (!["debug", "release"].includes(profile)) fail(`PARITY_CARGO_PROFILE must be 'debug' or 'release' (got: ${profile})`);
  const chdman = env.CHDMAN_BIN || "chdman";
  const dolphin = env.DOLPHIN_TOOL_BIN || "dolphin-tool";
  const sevenzip = env.SEVENZIP_BIN || "7zz";
  const zip = env.ZIP_BIN || "zip";
  const unzip = env.UNZIP_BIN || "unzip";
  requireTool("CHDMAN", chdman, env);
  requireTool("DOLPHIN_TOOL", dolphin, env);
  requireTool("SEVENZIP", sevenzip, env);
  requireTool("ZIP", zip, env);
  requireTool("UNZIP", unzip, env);
  const cli = env.ROM_WEAVER_BIN || join(root, "target", profile, "rom-weaver");
  if (!env.ROM_WEAVER_BIN && !existsSync(cli)) {
    log(`building rom-weaver CLI (${profile} profile)`);
    run("cargo", ["build", "--manifest-path", join(root, "Cargo.toml"), ...(profile === "release" ? ["--release"] : []), "-p", "rom-weaver-cli"]);
  }
  if (!existsSync(cli)) fail(`rom-weaver CLI not found/executable at: ${cli}`);
  log(`rom-weaver: ${cli}`);
  log(`chdman:     ${findTool(chdman, env) || chdman}`);
  log(`dolphin:    ${findTool(dolphin, env) || dolphin}`);
  log(`7zz:        ${findTool(sevenzip, env) || sevenzip}`);
  log(`zip:        ${findTool(zip, env) || zip}`);
  log(`unzip:      ${findTool(unzip, env) || unzip}`);

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

  // Archive containers carry tool-specific metadata, so comparing their raw
  // bytes would reject valid output. Compare the payload bytes after each
  // implementation reads the other one's archive instead.
  section("7z and ZIP payload parity vs reference tools");
  const archiveDir = join(workRoot, "archives");
  mkdirSync(archiveDir);
  const archiveSource = join(archiveDir, "payload.bin");
  generateFixture(archiveSource, 4 * 1024 * 1024);
  log(`fixture payload.bin sha1=${sha1(archiveSource)} (${readFileSync(archiveSource).length} bytes)`);

  const rw7z = join(archiveDir, "rw.7z");
  run(cli, ["compress", "--input", archiveSource, "--format", "7z", "--output", rw7z, "--codec", "lzma2:5", "--threads", "1", "--json"]);
  const rw7zExtract = join(archiveDir, "rw-7z-extract");
  mkdirSync(rw7zExtract);
  run(sevenzip, ["x", "-y", "-bso0", "-bsp0", `-o${rw7zExtract}`, rw7z]);
  failures += reportExtract(join(rw7zExtract, "payload.bin"), archiveSource, "7zz-extracted rom-weaver 7z");

  const reference7z = join(archiveDir, "ref.7z");
  run(sevenzip, ["a", "-t7z", "-m0=lzma2", "-mx=5", "-mmt=on", "-bso0", "-bsp0", reference7z, "payload.bin"], { cwd: archiveDir });
  const ref7zExtract = join(archiveDir, "ref-7z-extract");
  mkdirSync(ref7zExtract);
  extractOne(cli, reference7z, ref7zExtract);
  failures += reportExtract(join(ref7zExtract, "payload.bin"), archiveSource, "rom-weaver-extracted 7zz 7z");

  const rwZip = join(archiveDir, "rw.zip");
  run(cli, ["compress", "--input", archiveSource, "--format", "zip", "--output", rwZip, "--codec", "deflate:6", "--threads", "1", "--json"]);
  const rwZipExtract = join(archiveDir, "rw-zip-extract");
  mkdirSync(rwZipExtract);
  run(unzip, ["-qq", "-o", rwZip, "-d", rwZipExtract]);
  failures += reportExtract(join(rwZipExtract, "payload.bin"), archiveSource, "unzip-extracted rom-weaver ZIP");

  const referenceZip = join(archiveDir, "ref.zip");
  run(zip, ["-6", "-q", "-j", referenceZip, "payload.bin"], { cwd: archiveDir });
  const refZipExtract = join(archiveDir, "ref-zip-extract");
  mkdirSync(refZipExtract);
  extractOne(cli, referenceZip, refZipExtract);
  failures += reportExtract(join(refZipExtract, "payload.bin"), archiveSource, "rom-weaver-extracted Info-ZIP");

  if (failures) fail(`${failures} parity check(s) FAILED -- a vendored codec may have regressed`);
  log("all parity checks PASSED (CHD vs chdman, RVZ vs dolphin-tool, 7z vs 7zz, ZIP vs Info-ZIP)");
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
