#!/usr/bin/env node

// Head-to-head benchmark: rom-weaver against the reference implementation for
// each format, timed by hyperfine.
//
//   chd  vs chdman           (MAME, defines the CHD format)
//   rvz  vs dolphin-tool     (Dolphin, defines the RVZ format)
//   7z   vs 7zz              (7-Zip, defines the 7z format)
//   zip  vs zip / unzip      (Info-ZIP)
//
// Both directions are measured - compress and extract - and output size is
// recorded next to every timing, because a compress that is faster because it
// compressed less is not a win and the size column is what makes that visible.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const log = (message) => process.stdout.write(`[bench] ${message}\n`);
const fail = (message) => { throw new Error(message); };

const DEFAULT_WARMUP = 1;
const DEFAULT_RUNS = 3;

// RVZ has no single "default" both tools agree on the way CHD does, so the
// suites below pin dolphin-tool's own suggested RVZ settings (zstd, level 5,
// 128 KiB blocks) on both sides. rom-weaver's RVZ block size is already
// 128 KiB (`RVZ_DEFAULT_CHUNK_SIZE`), so only codec and level need saying.
const RVZ_CODEC = "zstd";
const RVZ_LEVEL = "5";
const RVZ_BLOCK = "131072";

// The archive suites pin each reference tool's own default effort on both
// sides: LZMA2 at level 5 (7-Zip's `-mx5`) and deflate at level 6 (Info-ZIP's
// default), both multi-threaded where the tool supports it.
const LZMA2_LEVEL = "5";
const DEFLATE_LEVEL = "6";

// What an archive suite will pack. Disc images are excluded on purpose: an
// LZMA2 pass over a 1.5 GB ISO runs for minutes and says more about the disc
// than about the archiver.
const ARCHIVE_INPUTS = [".gba", ".nds", ".sfc", ".smc", ".n64", ".z64", ".nes", ".gb", ".gbc"];

// rom-weaver unpacks archives found inside archives; 7zz and unzip stop after
// one layer. Without this the two sides would not be doing the same work.
const ONE_LAYER = "--no-nested-extract";

export const SUITES = {
  chd: {
    reference: "chdman",
    compressFrom: [".cue"],
    extractFrom: [".chd"],
    compressOutput: "out.chd",
    // chdman and rom-weaver already agree on the CHD-CD codec set
    // (cdlz,cdzl,cdfl) and both use every core, so neither side is tuned.
    compressCommands: (source, rwOut, refOut) => ({
      rw: ["compress", "--input", source, "--output", rwOut],
      ref: ["createcd", "-f", "-i", source, "-o", refOut],
    }),
    extractCommands: (source, rwDir, refDir, reference) => {
      const subcommand = chdmanExtractSubcommand(reference, source);
      const target = join(refDir, subcommand === "extractcd" ? "out.cue" : "out.iso");
      return { rw: ["extract", "--input", source, "--output", rwDir], ref: [subcommand, "-f", "-i", source, "-o", target], subcommand };
    },
  },
  rvz: {
    reference: "dolphin-tool",
    compressFrom: [".iso", ".gcm"],
    extractFrom: [".rvz"],
    compressOutput: "out.rvz",
    compressCommands: (source, rwOut, refOut, _reference, userDir) => ({
      rw: ["compress", "--input", source, "--output", rwOut, "--codec", `${RVZ_CODEC}:${RVZ_LEVEL}`],
      ref: ["convert", "-u", userDir, "-i", source, "-o", refOut, "-f", "rvz", "-c", RVZ_CODEC, "-l", RVZ_LEVEL, "-b", RVZ_BLOCK],
    }),
    extractCommands: (source, rwDir, refDir, _reference, userDir) => ({
      rw: ["extract", "--input", source, "--output", rwDir],
      ref: ["convert", "-u", userDir, "-i", source, "-o", join(refDir, "out.iso"), "-f", "iso"],
    }),
  },
  "7z": {
    reference: "7zz",
    compressFrom: ARCHIVE_INPUTS,
    extractFrom: [".7z"],
    compressOutput: "out.7z",
    compressCommands: (source, rwOut, refOut) => ({
      rw: ["compress", "--input", source, "--output", rwOut, "--codec", `lzma2:${LZMA2_LEVEL}`],
      ref: ["a", "-t7z", "-m0=lzma2", `-mx=${LZMA2_LEVEL}`, "-mmt=on", "-bso0", "-bsp0", refOut, source],
    }),
    extractCommands: (source, rwDir, refDir) => ({
      rw: ["extract", "--input", source, "--output", rwDir, ONE_LAYER],
      ref: ["x", "-y", "-bso0", "-bsp0", `-o${refDir}`, source],
    }),
  },
  zip: {
    reference: "zip",
    compressFrom: ARCHIVE_INPUTS,
    extractFrom: [".zip"],
    compressOutput: "out.zip",
    // Info-ZIP writes relative to the working directory and stores the path it
    // was given, so it is handed an absolute source like every other tool here.
    compressCommands: (source, rwOut, refOut) => ({
      rw: ["compress", "--input", source, "--output", rwOut, "--codec", `deflate:${DEFLATE_LEVEL}`],
      ref: [`-${DEFLATE_LEVEL}`, "-q", "-j", refOut, source],
    }),
    extractCommands: (source, rwDir, refDir) => ({
      rw: ["extract", "--input", source, "--output", rwDir, ONE_LAYER],
      ref: ["-qq", "-o", source, "-d", refDir],
    }),
  },
};

// unzip, not zip, is what reads a zip back; the suite's `reference` names the
// writer, so the extract side swaps in the matching reader.
const EXTRACT_REFERENCE = { zip: "unzip" };

export function parseArgs(argv) {
  const options = {
    corpus: "",
    out: "dist/bench/disc-tools",
    romWeaver: process.env.ROM_WEAVER_BIN || "target/release/rom-weaver",
    reference: "",
    warmup: DEFAULT_WARMUP,
    runs: DEFAULT_RUNS,
    cases: "compress,extract",
    suite: "chd",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split(/=(.*)/s);
    const value = inlineValue ?? argv[index + 1];
    const consume = () => { if (inlineValue === undefined) index += 1; return value; };
    switch (flag) {
      case "--corpus": options.corpus = consume(); break;
      case "--out": options.out = consume(); break;
      case "--rom-weaver-bin": options.romWeaver = consume(); break;
      case "--reference-bin": options.reference = consume(); break;
      case "--warmup": options.warmup = Number(consume()); break;
      case "--runs": options.runs = Number(consume()); break;
      case "--cases": options.cases = consume(); break;
      case "--suite": options.suite = consume(); break;
      default: fail(`unknown option: ${flag}`);
    }
  }
  if (!SUITES[options.suite]) fail(`--suite must be one of ${Object.keys(SUITES).join(", ")} (got: ${options.suite})`);
  if (!options.corpus) fail("--corpus <dir> is required: a directory of disc images to benchmark against");
  if (!Number.isInteger(options.runs) || options.runs < 1) fail(`--runs must be a positive integer (got: ${options.runs})`);
  if (!Number.isInteger(options.warmup) || options.warmup < 0) fail(`--warmup must be a non-negative integer (got: ${options.warmup})`);
  options.reference ||= SUITES[options.suite].reference;
  return options;
}

// Recursive because a ROM corpus is organised by title, not by format: a cue
// and its tracks live one directory down from the corpus root.
export function discover(root, extensions, depth = 0) {
  if (depth > 3 || !existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) { found.push(...discover(path, extensions, depth + 1)); continue; }
    if (extensions.includes(extname(entry.name).toLowerCase())) found.push(path);
  }
  return found;
}

// A cue sheet is a few hundred bytes of text pointing at the tracks that carry
// the disc, so its own size says nothing about the work a compress does. The
// input size is the sheet plus every file it names.
export function sourceSize(path) {
  if (extname(path).toLowerCase() !== ".cue") return treeSize(path);
  const directory = dirname(path);
  const tracks = [...readFileSync(path, "utf8").matchAll(/^\s*FILE\s+"([^"]+)"/gim)];
  return tracks.reduce((total, [, name]) => total + treeSize(join(directory, name)), treeSize(path));
}

function treeSize(path) {
  if (!existsSync(path)) return 0;
  if (statSync(path).isFile()) return statSync(path).size;
  return readdirSync(path).reduce((total, entry) => total + treeSize(join(path, entry)), 0);
}

// hyperfine reports the timings but not what the commands wrote, so size comes
// from one separate untimed execution of the same command.
//
// Exit status alone is not enough to trust it: chdman 0.287 terminates on an
// uncaught exception for inputs it cannot handle and still exits 0, which would
// score a crash as an extremely fast success. An empty output is the failure it
// looks like.
//
// `ensureDir` is for the tools that write *into* a directory rather than
// creating it: chdman is handed `<dir>/out.cue` and fails if <dir> is missing,
// which the clean-slate rm above would otherwise have just guaranteed.
function measureOutput(command, args, outputPath, workdir, ensureDir = "") {
  rmSync(outputPath, { recursive: true, force: true });
  if (ensureDir) mkdirSync(ensureDir, { recursive: true });
  const result = spawnSync(command, args, { cwd: workdir, encoding: "utf8", maxBuffer: Infinity });
  const diagnostics = `${result.stdout || ""}${result.stderr || ""}`.trim() || "(no output)";
  if (result.status !== 0) fail(`${basename(command)} failed (exit ${result.status}):\n${diagnostics}`);
  const bytes = treeSize(outputPath);
  if (bytes === 0) fail(`${basename(command)} exited 0 but wrote nothing to ${basename(outputPath)}:\n${diagnostics}`);
  return bytes;
}

// chdman splits extraction across subcommands by disc type, and picks none of
// them for you. The type comes from the CHD's own metadata tag: CHT2/CHTR is a
// CD, CHGD a GD-ROM, and 'DVD ' a DVD. rom-weaver reads the same tag itself,
// which is why its side of the benchmark is one command for all three.
export function chdmanExtractSubcommand(chdman, source) {
  const info = spawnSync(chdman, ["info", "-i", source], { encoding: "utf8", maxBuffer: Infinity });
  const text = `${info.stdout || ""}${info.stderr || ""}`;
  if (/Tag='(?:CHT2|CHTR|CHGD)'/.test(text)) return "extractcd";
  if (/Tag='DVD '/.test(text)) return "extractdvd";
  if (/Tag='GDDD'/.test(text)) return "extracthd";
  return fail(`could not determine CHD type for ${basename(source)} from '${basename(chdman)} info'`);
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const slug = (value) => value.replaceAll(/[^\w.-]+/g, "_");

function runHyperfine({ name, commands, prepare, out, warmup, runs, workdir }) {
  const jsonPath = join(out, `${name}.json`);
  const args = [
    "--warmup", String(warmup),
    "--runs", String(runs),
    "--export-json", jsonPath,
    "--command-name", "rom-weaver",
    "--command-name", "reference",
  ];
  if (prepare) args.push("--prepare", prepare);
  args.push(...commands);
  log(`hyperfine ${name} (${runs} runs, ${warmup} warmup)`);
  execFileSync("hyperfine", args, { cwd: workdir, stdio: "inherit" });
  return JSON.parse(readFileSync(jsonPath, "utf8"));
}

const summarize = (results, index) => {
  const { mean, stddev, min, max } = results.results[index];
  return { mean, stddev, min, max };
};

function benchmarkCase({ kind, source, suite, suiteName, romWeaver, reference, out, warmup, runs, workdir }) {
  const isCompress = kind === "compress";
  const tool = isCompress ? reference : EXTRACT_REFERENCE[suiteName] || reference;
  const rwOut = join(workdir, isCompress ? `rw-${suite.compressOutput}` : "rw-extract");
  const refOut = join(workdir, isCompress ? `ref-${suite.compressOutput}` : "ref-extract");
  // dolphin-tool needs a writable user folder for its temporary processing
  // files, and will silently create one somewhere else if not told where.
  const userDir = join(workdir, "dolphin-user");
  mkdirSync(userDir, { recursive: true });

  const build = isCompress ? suite.compressCommands : suite.extractCommands;
  const { rw: rwArgs, ref: refArgs, subcommand } = build(source, rwOut, refOut, tool, userDir);
  // On compress both tools name the output file; on extract rom-weaver creates
  // its own directory while the reference writes into one that must exist.
  const refEnsure = isCompress ? "" : refOut;

  const rwBytes = measureOutput(romWeaver, rwArgs, rwOut, workdir);
  const refBytes = measureOutput(tool, refArgs, refOut, workdir, refEnsure);

  const results = runHyperfine({
    name: `${kind}-${slug(basename(source, extname(source)))}`,
    commands: [
      [romWeaver, ...rwArgs].map(quote).join(" "),
      [tool, ...refArgs].map(quote).join(" "),
    ],
    // Every run starts from the same clean slate rather than from whatever the
    // previous run left behind.
    prepare: `rm -rf ${quote(rwOut)} ${quote(refOut)}${refEnsure ? ` && mkdir -p ${quote(refEnsure)}` : ""}`,
    out, warmup, runs, workdir,
  });

  return {
    case: kind,
    source,
    ...(subcommand ? { subcommand } : {}),
    referenceTool: tool,
    sourceBytes: sourceSize(source),
    romWeaver: { ...summarize(results, 0), outputBytes: rwBytes },
    reference: { ...summarize(results, 1), outputBytes: refBytes },
  };
}

export function runBenchmark(options) {
  const suite = SUITES[options.suite];
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const workdir = join(out, "work");
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  const romWeaver = resolve(options.romWeaver);
  if (!existsSync(romWeaver)) fail(`rom-weaver binary not found: ${romWeaver} (build it with 'cargo build --release -p rom-weaver-cli')`);

  const kinds = new Set(options.cases.split(",").map((value) => value.trim()).filter(Boolean));
  const wanted = [
    ...(kinds.has("compress") ? discover(resolve(options.corpus), suite.compressFrom).map((source) => ["compress", source]) : []),
    ...(kinds.has("extract") ? discover(resolve(options.corpus), suite.extractFrom).map((source) => ["extract", source]) : []),
  ];
  if (wanted.length === 0) fail(`no ${options.suite} sources found under ${options.corpus}`);

  const entries = [];
  for (const [kind, source] of wanted) {
    // A corpus is heterogeneous - a disc subtype one tool declines is a normal
    // thing to find in it. Recording the refusal keeps the rest of the run,
    // which aborting would throw away.
    try {
      entries.push(benchmarkCase({ kind, source, suite, suiteName: options.suite, romWeaver, reference: options.reference, out, warmup: options.warmup, runs: options.runs, workdir }));
    } catch (error) {
      log(`SKIP ${kind} ${basename(source)}: ${error.message.split("\n")[0]}`);
      entries.push({ case: kind, source, skipped: error.message });
    }
  }

  const report = {
    generated: new Date().toISOString(),
    suite: options.suite,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim(),
    },
    romWeaverVersion: execFileSync(romWeaver, ["--version"], { encoding: "utf8" }).trim(),
    reference: options.reference,
    runs: options.runs,
    warmup: options.warmup,
    entries,
  };
  writeFileSync(join(out, `report-${options.suite}.json`), `${JSON.stringify(report, null, 2)}\n`);
  rmSync(workdir, { recursive: true, force: true });
  log(`wrote ${join(out, `report-${options.suite}.json`)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBenchmark(parseArgs(process.argv.slice(2)));
}
