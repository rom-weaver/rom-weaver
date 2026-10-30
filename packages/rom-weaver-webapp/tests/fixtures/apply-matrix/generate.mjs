#!/usr/bin/env node
// Regenerates the apply-matrix fixtures. Idempotent: existing files whose sha256 already matches the
// deterministic expectation are left alone; missing or stale ones are rewritten.
//
//   node generate.mjs                 # build everything that can be built, write manifest.json
//   node generate.mjs --check         # verify files against manifest.json, exit 1 on drift
//
// Layout:
//   blobs/   small deterministic fixtures built by encoders.mjs (pure Node). Safe to commit.
//   $RW_MATRIX_CACHE (default ~/.cache/agents/apply-matrix-fixtures/webapp)
//            fixtures that need an external tool: host archivers (xz, bzip2, zstd, lz4, zip, tar) and
//            the native rom-weaver CLI (RW_BIN or target/release/rom-weaver) for formats that only it
//            can write (dps, rup, ppf, aps, apsgba, pat, solid, mod, bdf, 7z, chd, rvz, z3ds ...).
// Anything whose tool is missing is recorded in manifest.json as "unavailable" with the reason.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as enc from "./encoders.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../../..");
export const BLOBS = path.join(HERE, "blobs");
export const CACHE =
  process.env.RW_MATRIX_CACHE || path.join(os.homedir(), ".cache/agents/apply-matrix-fixtures/webapp");
const MANIFEST = path.join(HERE, "manifest.json");
const CRATE_FIXTURES = path.join(REPO, "crates/rom-weaver-patches/tests/fixtures/hdiffpatch");

export const cliPath = () => {
  const candidates = [
    process.env.RW_BIN,
    path.join(REPO, "target/release/rom-weaver"),
    path.join(REPO, "target/debug/rom-weaver"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
};

const hostTool = (name) => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() || null;

// ---- deterministic source / target data ----------------------------------------------------------

const BASE = enc.prng(8192, 0x1badf00d);
const OTHER = enc.prng(8192, 0x0ddba11); // same size, different content: the "wrong source"
const edit = (bytes) => {
  const out = Uint8Array.from(bytes);
  out.set([0xde, 0xad, 0xbe, 0xef], 0x10);
  out.fill(0xaa, 0x200, 0x240); // RLE-friendly run
  out[0x800] ^= 0xff;
  out.set(enc.prng(16, 7), 0x1ff0);
  return out;
};
const SAME = edit(BASE);
const GROW = enc.concat(SAME, enc.prng(1500, 99));
const SHRINK = SAME.slice(0, 6000);
const TARGETS = { same: SAME, grow: GROW, shrink: SHRINK };

const text = (s) => new TextEncoder().encode(s);

/** Pure-Node patch fixtures. */
const JS_PATCHES = [
  { encode: (s, t) => enc.encodeIps(s, t), ext: ".ips", format: "ips", variant: "same" },
  { encode: (s, t) => enc.encodeIps(s, t), ext: ".ips", format: "ips", variant: "grow" },
  {
    encode: (s, t) => enc.encodeIps(s, t, { truncate: true }),
    ext: ".ips",
    format: "ips",
    variant: "shrink",
  },
  { encode: (s, t) => enc.encodeIps32(s, t), ext: ".ips32", format: "ips32", variant: "same" },
  { encode: (s, t) => enc.encodeIps32(s, t), ext: ".ips32", format: "ips32", variant: "grow" },
  { encode: (s, t) => enc.encodeEbp(s, t), ext: ".ebp", format: "ebp", variant: "same" },
  {
    encode: (s, t) => enc.encodeBps(s, t, "apply-matrix"),
    ext: ".bps",
    format: "bps",
    variant: "same",
  },
  { encode: (s, t) => enc.encodeBps(s, t), ext: ".bps", format: "bps", variant: "grow" },
  { encode: (s, t) => enc.encodeBps(s, t), ext: ".bps", format: "bps", variant: "shrink" },
  { encode: (s, t) => enc.encodeUps(s, t), ext: ".ups", format: "ups", variant: "same" },
  { encode: (s, t) => enc.encodeUps(s, t), ext: ".ups", format: "ups", variant: "grow" },
  { encode: (s, t) => enc.encodeUps(s, t), ext: ".ups", format: "ups", variant: "shrink" },
  { encode: (s, t) => enc.encodeVcdiff(s, t), ext: ".xdelta", format: "xdelta", variant: "same" },
  { encode: (s, t) => enc.encodeVcdiff(s, t), ext: ".xdelta", format: "xdelta", variant: "grow" },
  { encode: (s, t) => enc.encodeVcdiff(s, t), ext: ".xdelta", format: "xdelta", variant: "shrink" },
  { encode: (s, t) => enc.encodeVcdiff(s, t), ext: ".vcdiff", format: "vcdiff", variant: "same" },
  { encode: (s, t) => enc.encodePpf3(s, t), ext: ".ppf", format: "ppf3", variant: "same" },
  { encode: (s, t) => enc.encodeGdiff(s, t), ext: ".gdiff", format: "gdiff", variant: "same" },
  { encode: (s, t) => enc.encodeGdiff(s, t), ext: ".gdiff", format: "gdiff", variant: "grow" },
  { encode: (s, t) => enc.encodeGdiff(s, t), ext: ".gdiff", format: "gdiff", variant: "shrink" },
];

/** Formats only the native CLI can create. Same-size target (some formats require it). */
const CLI_PATCH_FORMATS = [
  { ext: ".dps", format: "dps" },
  { ext: ".rup", format: "rup" },
  { ext: ".ppf", format: "ppf" },
  { ext: ".aps", format: "aps" },
  { ext: ".apsgba", format: "apsgba" },
  { ext: ".pat", format: "pat" },
  { ext: ".solid", format: "solid" },
  { ext: ".mod", format: "mod" },
  { ext: ".bdf", format: "bdf" },
];

const fixtureName = (format, variant, ext) => `${format}-${variant}${ext}`;

const sha = enc.sha256;
const manifest = { generatedBy: "tests/fixtures/apply-matrix/generate.mjs", entries: [] };

const record = (entry) => {
  manifest.entries.push(entry);
  return entry;
};

const writeIfChanged = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && sha(fs.readFileSync(file)) === sha(bytes)) return;
  fs.writeFileSync(file, bytes);
};

const putBlob = (name, bytes, purpose, how, dir = BLOBS, extra = {}) => {
  writeIfChanged(path.join(dir, name), bytes);
  return record({
    name,
    dir: dir === BLOBS ? "blobs" : "cache",
    purpose,
    sha256: sha(bytes),
    size: bytes.length,
    how,
    ...extra,
  });
};

const unavailable = (name, purpose, how, reason) => record({ name, dir: "cache", purpose, how, unavailable: reason });

const sh = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...options });

export function generate({ writeManifest = true } = {}) {
  manifest.entries = [];
  // Raw sources and targets.
  putBlob("base.bin", BASE, "source ROM every patch applies to (8 KiB, xorshift32 seed 0x1badf00d)", "encoders.prng");
  putBlob("other.bin", OTHER, "wrong-source ROM: same size as base.bin, different bytes", "encoders.prng");
  for (const [variant, bytes] of Object.entries(TARGETS))
    putBlob(
      `target-${variant}.bin`,
      bytes,
      `expected apply output (${variant})`,
      "base.bin with 4 edits (+1500 B appended | truncated to 6000 B)",
    );

  // Pure-Node patches.
  for (const { encode, ext, format, variant } of JS_PATCHES)
    putBlob(
      fixtureName(format, variant, ext),
      encode(BASE, TARGETS[variant]),
      `${format} ${variant}: base.bin -> target-${variant}.bin`,
      `encoders.${format} (independent of the Rust implementation)`,
    );
  putBlob(
    "ips-noop.ips",
    enc.encodeIps(BASE, BASE),
    "valid IPS with zero records (identity patch): output must equal base.bin",
    "encoders.encodeIps(base, base)",
  );
  putBlob("empty.ips", new Uint8Array(), "zero-byte patch file (error UX)", "empty");

  // Chain: base -> c1 -> ... -> c8, one pure-Node format per step. Applying all eight in order must give chain-final.bin.
  const chainSteps = [
    { encode: (a, b) => enc.encodeIps(a, b), ext: ".ips", format: "ips" },
    { encode: (a, b) => enc.encodeIps32(a, b), ext: ".ips32", format: "ips32" },
    { encode: (a, b) => enc.encodeEbp(a, b), ext: ".ebp", format: "ebp" },
    { encode: (a, b) => enc.encodeBps(a, b), ext: ".bps", format: "bps" },
    { encode: (a, b) => enc.encodeUps(a, b), ext: ".ups", format: "ups" },
    { encode: (a, b) => enc.encodeVcdiff(a, b), ext: ".xdelta", format: "xdelta" },
    { encode: (a, b) => enc.encodeGdiff(a, b), ext: ".gdiff", format: "gdiff" },
    { encode: (a, b) => enc.encodeVcdiff(a, b), ext: ".vcdiff", format: "vcdiff" },
  ];
  let previous = BASE;
  chainSteps.forEach(({ encode, ext, format }, index) => {
    const next = Uint8Array.from(previous);
    next.set(enc.prng(24, 1000 + index), 0x300 + index * 0x100);
    putBlob(
      `chain-${index + 1}-${format}${ext}`,
      encode(previous, next),
      `chain step ${index + 1} (${format}): c${index} -> c${index + 1}`,
      `encoders.${format}`,
    );
    if (index === chainSteps.length - 1)
      putBlob("chain-final.bin", next, "expected result of the full 8-step chain", "base.bin + 8 successive edits");
    if (index === chainSteps.length - 2)
      putBlob("chain-final-minus1.bin", next, "expected result when the last chain step is switched off", "chain c7");
    previous = next;
  });

  // Checksum-bearing pair chain (bps -> ups -> bps): the app can detect the right order from the checks.
  {
    const p1 = Uint8Array.from(BASE);
    p1.set(enc.prng(16, 71), 0x500);
    const p2 = Uint8Array.from(p1);
    p2.set(enc.prng(16, 72), 0x900);
    const p3 = Uint8Array.from(p2);
    p3.set(enc.prng(16, 73), 0xd00);
    putBlob("pair-1.bps", enc.encodeBps(BASE, p1), "order-detectable chain step 1: base -> p1 (bps)", "encoders.bps");
    putBlob("pair-2.ups", enc.encodeUps(p1, p2), "order-detectable chain step 2: p1 -> p2 (ups)", "encoders.ups");
    putBlob("pair-3.bps", enc.encodeBps(p2, p3), "order-detectable chain step 3: p2 -> p3 (bps)", "encoders.bps");
    putBlob("pair-final.bin", p3, "expected result of pair-1..3", "base + 3 edits");
  }

  // hdiffpatch: reuse the crate's upstream-produced fixtures.
  if (fs.existsSync(CRATE_FIXTURES)) {
    const hSource = fs.readFileSync(path.join(CRATE_FIXTURES, "source.bin"));
    putBlob(
      "hdiff-source.bin",
      hSource,
      "source for the upstream hdiffpatch fixtures (copied from crates/rom-weaver-patches/tests/fixtures/hdiffpatch)",
      "copy",
    );
    putBlob(
      "hdiff-target.bin",
      fs.readFileSync(path.join(CRATE_FIXTURES, "target.bin")),
      "expected output of the hdiffpatch fixtures",
      "copy",
    );
    for (const file of fs.readdirSync(CRATE_FIXTURES).filter((n) => /\.(hdiff|hpatchz)$/.test(n)))
      putBlob(
        file.replace(/^upstream-/, "hdiffpatch-"),
        fs.readFileSync(path.join(CRATE_FIXTURES, file)),
        `upstream-produced ${file}`,
        "copy from crate fixtures",
      );
  }

  // Tool-generated, outside git.
  const cli = cliPath();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rw-matrix-gen-"));
  try {
    fs.writeFileSync(path.join(work, "base.bin"), BASE);
    for (const [variant, bytes] of Object.entries(TARGETS))
      fs.writeFileSync(path.join(work, `target-${variant}.bin`), bytes);

    for (const { ext, format } of CLI_PATCH_FORMATS) {
      const name = fixtureName(format, "same", ext);
      const how = `rom-weaver patch create --original base.bin --modified target-same.bin --output ${name}`;
      if (!cli) {
        unavailable(
          name,
          `${format} same-size patch`,
          how,
          "native CLI not built (set RW_BIN or build target/release/rom-weaver)",
        );
        continue;
      }
      const out = path.join(work, name);
      const result = spawnSync(
        cli,
        [
          "patch",
          "create",
          "--original",
          path.join(work, "base.bin"),
          "--modified",
          path.join(work, "target-same.bin"),
          "--output",
          out,
          "--no-progress",
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0 || !fs.existsSync(out)) {
        unavailable(
          name,
          `${format} same-size patch`,
          how,
          `CLI could not create it: ${(result.stderr || result.stdout).trim().split("\n").pop()}`,
        );
        continue;
      }
      putBlob(
        name,
        new Uint8Array(fs.readFileSync(out)),
        `${format} same-size patch created by the native CLI; apply must reproduce target-same.bin`,
        how,
        CACHE,
      );
    }

    // Second chain from CLI-only formats, each patch created natively from the previous target.
    let prevBytes = BASE;
    const cliChain = ["dps", "rup", "ppf", "aps", "pat", "solid", "apsgba", "bdf"];
    for (const [index, format] of cliChain.entries()) {
      const name = `cchain-${index + 1}-${format}.${format}`;
      if (!cli) {
        unavailable(name, `CLI chain step ${index + 1}`, "rom-weaver patch create", "native CLI not built");
        continue;
      }
      const next = Uint8Array.from(prevBytes);
      next.set(enc.prng(24, 2000 + index), 0x400 + index * 0x100);
      fs.writeFileSync(path.join(work, "a.bin"), prevBytes);
      fs.writeFileSync(path.join(work, "b.bin"), next);
      const out = path.join(work, name);
      const result = spawnSync(
        cli,
        [
          "patch",
          "create",
          "--original",
          path.join(work, "a.bin"),
          "--modified",
          path.join(work, "b.bin"),
          "--output",
          out,
          "--no-progress",
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0 || !fs.existsSync(out)) {
        unavailable(
          name,
          `CLI chain step ${index + 1}`,
          "rom-weaver patch create",
          (result.stderr || "").trim().split("\n").pop(),
        );
        continue;
      }
      putBlob(
        name,
        new Uint8Array(fs.readFileSync(out)),
        `native-chain step ${index + 1} (${format})`,
        "rom-weaver patch create",
        CACHE,
      );
      if (index === cliChain.length - 1)
        putBlob(
          "cchain-final.bin",
          next,
          "expected result of the 8-step native-format chain",
          "base.bin + 8 edits",
          CACHE,
        );
      prevBytes = next;
    }

    // PMSR (.mod) is defined for exactly one source: Paper Mario USA 1.0 (40 MiB, CRC32 a7f5cd7e). A 40 MiB
    // synthetic stand-in with a forged CRC32 exercises the real apply path (and "large-ish file" handling).
    {
      const size = 41_943_040;
      const filler = new Uint8Array(size - 4);
      filler.set(enc.prng(65536, 0x5eed), 0);
      filler.set(enc.prng(65536, 0xfeed), size - 4 - 65536);
      const source = enc.concat(filler, enc.forgeCrc32Tail(filler, 0xa7f5cd7e));
      const edited = Uint8Array.from(source);
      edited.set(enc.prng(32, 11), 0x1000);
      edited.set(enc.prng(32, 12), 0x200000);
      putBlob(
        "pmsr-source.z64",
        source,
        "synthetic 40 MiB Paper-Mario-USA-1.0 stand-in (CRC32 a7f5cd7e forged)",
        "encoders.prng + forgeCrc32Tail",
        CACHE,
      );
      putBlob("pmsr-target.z64", edited, "expected output of pmsr-large.mod", "pmsr-source.z64 with 2 edits", CACHE);
      if (cli) {
        fs.writeFileSync(path.join(work, "ps.z64"), source);
        fs.writeFileSync(path.join(work, "pt.z64"), edited);
        const out = path.join(work, "pmsr-large.mod");
        const result = spawnSync(
          cli,
          [
            "patch",
            "create",
            "--original",
            path.join(work, "ps.z64"),
            "--modified",
            path.join(work, "pt.z64"),
            "--output",
            out,
            "--no-progress",
          ],
          { encoding: "utf8" },
        );
        if (result.status === 0 && fs.existsSync(out))
          putBlob(
            "pmsr-large.mod",
            new Uint8Array(fs.readFileSync(out)),
            "PMSR patch for the 40 MiB stand-in (native CLI)",
            "rom-weaver patch create",
            CACHE,
          );
        else
          unavailable(
            "pmsr-large.mod",
            "PMSR patch",
            "rom-weaver patch create",
            (result.stderr || "").trim().split("\n").pop(),
          );
      } else unavailable("pmsr-large.mod", "PMSR patch", "rom-weaver patch create", "native CLI not built");
    }

    // Archive/compression variants of the ROM and a patch.
    const payloads = [
      { bytes: BASE, fileName: "base.bin", kind: "rom" },
      { bytes: enc.encodeBps(BASE, SAME), fileName: "bps-same.bps", kind: "patch" },
    ];
    for (const { bytes, fileName, kind } of payloads) {
      const src = path.join(work, fileName);
      fs.writeFileSync(src, bytes);
      putBlob(
        `${kind}.zip`,
        enc.zip([{ name: fileName, data: bytes }]),
        `${kind} inside a zip (deflate)`,
        "encoders.zip",
        CACHE,
      );
      putBlob(
        `${kind}-stored.zip`,
        enc.zip([{ name: fileName, data: bytes, store: true }]),
        `${kind} inside a zip (stored)`,
        "encoders.zip store",
        CACHE,
      );
      putBlob(`${kind}.tar`, enc.tar([{ name: fileName, data: bytes }]), `${kind} inside a tar`, "encoders.tar", CACHE);
      // Conventional single-payload names (<file>.<codec>) hold a payload that keeps its extension; the
      // bare `<kind>.<codec>` names hold an extension-less payload, which the webapp treats differently.
      putBlob(
        `${fileName}.gz`,
        enc.gzip(bytes, fileName),
        `${kind} gzip, conventional name <file>.gz (FNAME = ${fileName})`,
        "encoders.gzip",
        CACHE,
      );
      putBlob(
        `${kind}.gz`,
        enc.gzip(bytes, fileName),
        `${kind} gzip named ${kind}.gz (FNAME = ${fileName}, differs from the stem)`,
        "encoders.gzip",
        CACHE,
      );
      putBlob(`${kind}-nofname.gz`, enc.gzip(bytes), `${kind} gzip with no FNAME header`, "encoders.gzip", CACHE);
      for (const { args, ext, tool } of [
        { args: ["-9e", "-k", "-c", src], ext: ".xz", tool: "xz" },
        { args: ["-9", "-k", "-c", src], ext: ".bz2", tool: "bzip2" },
        { args: ["-19", "-q", "-c", src], ext: ".zst", tool: "zstd" },
        { args: ["-9", "-q", "-c", src], ext: ".lz4", tool: "lz4" },
      ]) {
        const name = `${kind}${ext}`;
        if (!hostTool(tool)) {
          unavailable(name, `${kind} ${tool}`, `${tool} ${args.join(" ")}`, `host tool ${tool} missing`);
          continue;
        }
        const compressed = new Uint8Array(sh(tool, args));
        putBlob(
          name,
          compressed,
          `${kind} compressed with ${tool} (extension-less payload name)`,
          `${tool} ${args.slice(0, -1).join(" ")}`,
          CACHE,
        );
        putBlob(
          `${fileName}${ext}`,
          compressed,
          `${kind} compressed with ${tool}, conventional name <file>${ext}`,
          `${tool} ${args.slice(0, -1).join(" ")}`,
          CACHE,
        );
      }
      const tarBytes = enc.tar([{ name: fileName, data: bytes }]);
      putBlob(`${kind}.tar.gz`, enc.gzip(tarBytes), `${kind} in tar.gz`, "encoders.gzip(tar)", CACHE);
      fs.writeFileSync(path.join(work, `${kind}.tar`), tarBytes);
      for (const { args, ext, tool } of [
        { args: ["-9e", "-k", "-c", path.join(work, `${kind}.tar`)], ext: ".tar.xz", tool: "xz" },
        {
          args: ["-9", "-k", "-c", path.join(work, `${kind}.tar`)],
          ext: ".tar.bz2",
          tool: "bzip2",
        },
      ]) {
        const name = `${kind}${ext}`;
        if (!hostTool(tool)) {
          unavailable(name, `${kind} ${ext}`, `${tool} ...`, `host tool ${tool} missing`);
          continue;
        }
        putBlob(name, new Uint8Array(sh(tool, args)), `${kind} in ${ext}`, `tar | ${tool}`, CACHE);
      }
      if (cli) {
        const out = path.join(work, `${kind}.7z`);
        const result = spawnSync(cli, ["compress", "--input", src, "--output", out, "--no-progress"], {
          encoding: "utf8",
        });
        if (result.status === 0 && fs.existsSync(out))
          putBlob(
            `${kind}.7z`,
            new Uint8Array(fs.readFileSync(out)),
            `${kind} inside a 7z (lzma2)`,
            `rom-weaver compress --input ${fileName} --output ${kind}.7z`,
            CACHE,
          );
        else
          unavailable(
            `${kind}.7z`,
            `${kind} 7z`,
            "rom-weaver compress",
            (result.stderr || "").trim().split("\n").pop(),
          );
      } else unavailable(`${kind}.7z`, `${kind} 7z`, "rom-weaver compress", "native CLI not built");
    }

    // Multi-member / nested / odd-name containers.
    const romEntry = { name: "base.bin", data: BASE };
    const bonus = enc.prng(2048, 5);
    putBlob(
      "multi-rom.zip",
      enc.zip([romEntry, { name: "bonus.sfc", data: bonus }, { name: "readme.txt", data: text("hello\n") }]),
      "zip with two ROM candidates plus a text file (selection UI)",
      "encoders.zip",
      CACHE,
    );
    putBlob(
      "patch-and-rom.zip",
      enc.zip([romEntry, { name: "bps-same.bps", data: enc.encodeBps(BASE, SAME) }]),
      "one zip holding both ROM and patch",
      "encoders.zip",
      CACHE,
    );
    putBlob(
      "multi-patch.zip",
      enc.zip([
        { name: "a-bps-same.bps", data: enc.encodeBps(BASE, SAME) },
        { name: "b-ips-same.ips", data: enc.encodeIps(BASE, SAME) },
      ]),
      "zip with two patches (selection UI)",
      "encoders.zip",
      CACHE,
    );
    const inner = enc.zip([romEntry]);
    putBlob(
      "nested.zip",
      enc.zip([{ name: "inner/rom.zip", data: inner }]),
      "zip within zip containing the ROM",
      "encoders.zip",
      CACHE,
    );
    putBlob(
      "unicode-ゲーム-é.zip",
      enc.zip([{ name: "ゲーム é.bin", data: BASE }]),
      "unicode archive name and member name",
      "encoders.zip utf8",
      CACHE,
    );
    putBlob("noext-rom", BASE, "ROM with no file extension", "copy of base.bin", CACHE);
    putBlob("empty-rom.bin", new Uint8Array(), "zero-byte ROM", "empty", CACHE);
    putBlob("truncated.zip", enc.zip([romEntry]).slice(0, 700), "zip cut short (corrupt container)", "slice", CACHE);
    putBlob("garbage.zip", enc.prng(512, 3), "random bytes named .zip", "prng", CACHE);

    if (hostTool("zip")) {
      // Encrypted zip via Info-ZIP (ZipCrypto).
      const out = path.join(work, "enc.zip");
      sh("zip", ["-q", "-X", "-P", "secret", out, "base.bin"], { cwd: work });
      putBlob(
        "encrypted.zip",
        new Uint8Array(fs.readFileSync(out)),
        "password-protected zip (ZipCrypto, password 'secret')",
        "zip -P secret",
        CACHE,
        // ZipCrypto writes random header bytes, so the hash differs on every build.
        { volatile: true },
      );
    } else unavailable("encrypted.zip", "encrypted zip", "zip -P", "host tool zip missing");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Hand-assembled BSP scripts and DLDI/DS samples, copied verbatim (small, deterministic) from the native-CLI
  // worker's fixtures (tests/fixtures/apply-matrix/{patches/bsp,dldi}); no host tool can create them.
  const borrowedDir = path.join(BLOBS, "borrowed");
  for (const file of fs.existsSync(borrowedDir) ? fs.readdirSync(borrowedDir).sort() : []) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(borrowedDir, file)));
    record({
      name: `borrowed/${file}`,
      dir: "blobs",
      purpose: /\.(bsp)$/.test(file)
        ? "BSP script patch (apply-only format)"
        : /\.(in|out)$/.test(file)
          ? "BSP script input/expected-output"
          : "DLDI driver or DS ROM sample",
      sha256: sha(bytes),
      size: bytes.length,
      how: "copied verbatim from tests/fixtures/apply-matrix of the cli worker (hand-assembled)",
    });
  }

  if (writeManifest) fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--check")) {
    const saved = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    let drift = 0;
    for (const entry of saved.entries.filter((candidate) => !candidate.unavailable)) {
      const file = path.join(entry.dir === "blobs" ? BLOBS : CACHE, entry.name);
      const stale =
        !fs.existsSync(file) ||
        (entry.volatile ? fs.statSync(file).size !== entry.size : sha(fs.readFileSync(file)) !== entry.sha256);
      if (stale) {
        console.error(`DRIFT ${entry.name}`);
        drift++;
      }
    }
    process.exit(drift ? 1 : 0);
  }
  const result = generate();
  const ok = result.entries.filter((entry) => !entry.unavailable).length;
  const missing = result.entries.filter((entry) => entry.unavailable);
  console.log(`fixtures: ${ok} ready, ${missing.length} unavailable`);
  for (const entry of missing) console.log(`  unavailable ${entry.name}: ${entry.unavailable}`);
}
