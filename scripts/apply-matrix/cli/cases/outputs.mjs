// Output side of apply: raw vs compressed results, codecs/levels/threads, determinism, output-path edge cases.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { add, check, skip } from "../lib/harness.mjs";
import { have } from "../lib/fixture-defs.mjs";

const ROM = "rom/base.bin";
const PATCH = "patches/ind/same.ips";
const TARGET = "rom/same.bin";
const LEVELS = ["min", "very-low", "low", "medium", "high", "very-high", "max"];

/** Extract an output container with rom-weaver and return the bytes of its single payload. */
const readBack = (ctx, file, tag = "rb") => {
  const dir = ctx.tmp(`${tag}-${path.basename(file)}.ex`);
  ctx.ok(ctx.run(["extract", "--input", file, "--output", dir]), `extract ${path.basename(file)}`);
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  check(files.length === 1, () => `expected one payload in ${path.basename(file)}, got ${files.map((f) => f.name).join(",")}`);
  return fs.readFileSync(path.join(files[0].parentPath ?? files[0].path, files[0].name));
};
const compressed = (ctx, output, extra = [], { rom = ROM, patch = PATCH, select } = {}) => ctx.apply(ctx.fx(rom), ctx.fx(patch), output, [...extra, ...(select ?? [])], { compress: true });

export const register = () => {
  // ----------------------------------------------------------------------------- raw output
  add("output.raw.no-compress-bin", ["output", "raw"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), "--no-compress");
    ctx.same(out, ctx.fx(TARGET), "raw output");
  });
  add("output.raw.raw-alias", ["output", "raw"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out, "--raw"]), "--raw");
    ctx.same(out, ctx.fx(TARGET), "raw output");
  });
  add("output.raw.extension-matching-rom-leaf-writes-raw", ["output", "raw"], (ctx) => {
    const rom = ctx.write("game.gb", fs.readFileSync(ctx.fx(ROM)));
    const out = ctx.tmp("out.gb");
    ctx.ok(ctx.run(["patch", "apply", "--input", rom, "--patch", ctx.fx(PATCH), "--output", out]), "output extension equals ROM extension");
    ctx.same(out, ctx.fx(TARGET), "raw output without any compression flag");
  });
  add("output.raw.bin-without-flag-is-ambiguous", ["output", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out]), { message: /ambiguous|no-compress/i, what: ".bin without --no-compress" });
    check(!ctx.exists(out), "left an output");
  });
  add("output.raw.no-extension-fails", ["output", "negative"], (ctx) => {
    const out = ctx.tmp("out");
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out]), { message: /extension/i, what: "no extension without flags" });
    check(!ctx.exists(out), "left an output");
  });
  add("output.raw.no-extension-with-no-compress", ["output", "raw"], (ctx) => {
    const out = ctx.tmp("out");
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), "extensionless + --no-compress");
    ctx.same(out, ctx.fx(TARGET), "output");
  });
  add("output.raw.unknown-extension-fails", ["output", "negative"], (ctx) => {
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", ctx.tmp("out.zzz")]), { message: /extension|container|no-compress/i, what: "unknown extension" });
  });
  add("output.raw.uppercase-extension", ["output", "raw"], (ctx) => {
    const out = ctx.tmp("OUT.BIN");
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), "uppercase .BIN --no-compress");
    ctx.same(out, ctx.fx(TARGET), "output");
  });
  add("output.raw.zip-extension-with-no-compress-stays-raw", ["output", "raw"], (ctx) => {
    const out = ctx.tmp("out.zip");
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), "--no-compress to .zip");
    ctx.same(out, ctx.fx(TARGET), "raw bytes written to the .zip name");
  });
  add("output.raw.stdout", ["output", "raw"], (ctx) => {
    const result = ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", "-", "--no-compress"]);
    ctx.ok(result, "--output -");
    check(Buffer.from(result.stdoutBytes).equals(fs.readFileSync(ctx.fx(TARGET))), "stdout bytes differ from the patched ROM (or progress text leaked into the binary stream)");
  });
  add("output.raw.default-name-sibling-and-collision-suffix", ["output", "raw"], (ctx) => {
    const rom = ctx.write("game.bin", fs.readFileSync(ctx.fx(ROM)));
    const first = ctx.run(["patch", "apply", "--input", rom, "--patch", ctx.fx(PATCH)]);
    ctx.ok(first, "no --output");
    check(ctx.exists(ctx.tmp("game-patched.bin")), "game-patched.bin missing");
    ctx.same(ctx.tmp("game-patched.bin"), ctx.fx(TARGET), "default-named output");
    ctx.ok(ctx.run(["patch", "apply", "--input", rom, "--patch", ctx.fx(PATCH)]), "second run");
    const siblings = fs.readdirSync(ctx.work).filter((name) => /^game-patched.*\.bin$/.test(name));
    check(siblings.length === 2, () => `expected a numeric-suffix sibling, got ${siblings.join(",")}`);
    for (const name of siblings) ctx.same(ctx.tmp(name), ctx.fx(TARGET), name);
  });

  // ---------------------------------------------------------------- zip / 7z codecs and levels
  const verifyIndependent = async (ctx, out, kind, codec) => {
    const { spawnSync } = await import("node:child_process");
    const useUnzip = kind === "zip" && !/zstd/.test(codec ?? "");
    const args = useUnzip ? ["unzip", ["-p", out]] : ["bsdtar", ["-xOf", out]];
    if (!have(args[0])) return "skipped-independent";
    const result = spawnSync(args[0], args[1], { maxBuffer: 1 << 28 });
    check(result.status === 0, () => `${args[0]} could not read the archive: ${result.stderr?.toString().slice(0, 200)}`);
    check(Buffer.from(result.stdout).equals(fs.readFileSync(ctx.fx(TARGET))), `${args[0]} extracted bytes differ from the patched ROM`);
    return "ok";
  };

  for (const [format, codecs] of [["zip", ["store", "deflate", "zstd"]], ["7z", ["lzma2"]]]) {
    for (const codec of codecs) {
      if (codec === "store") {
        add(`output.${format}.codec-store.level-rejected`, ["output", format, "negative"], (ctx) => {
          ctx.failed(compressed(ctx, ctx.tmp(`out.${format}`), ["--compress-codec", "store", "--compress-level", "max"]), { message: /does not accept --compress-level/, what: "store codec with a level" });
        });
      }
      for (const level of codec === "store" ? [] : LEVELS) {
        add(`output.${format}.codec-${codec}.level-${level}`, ["output", format, codec, level], async (ctx) => {
          const out = ctx.tmp(`out.${format}`);
          ctx.ok(compressed(ctx, out, ["--compress-codec", codec, "--compress-level", level]), `${format} ${codec} ${level}`);
          ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "round-trip through rom-weaver extract");
          await verifyIndependent(ctx, out, format, codec);
        });
      }
      add(`output.${format}.codec-${codec}.determinism`, ["output", format, codec, "determinism"], (ctx) => {
        const outputs = [];
        for (const [label, threads] of [["a", "1"], ["b", "1"], ["c", "4"], ["d", "16"]]) {
          const out = ctx.tmp(`${label}/out.${format}`);
          ctx.ok(compressed(ctx, out, ["--compress-codec", codec, "--threads", threads]), `${format} ${codec} -j${threads}`);
          outputs.push(out);
        }
        for (const out of outputs.slice(1)) ctx.same(out, outputs[0], `${path.relative(ctx.work, out)} vs first run`);
      });
    }
    add(`output.${format}.default-codec-from-extension`, ["output", format], async (ctx) => {
      const out = ctx.tmp(`out.${format}`);
      ctx.ok(compressed(ctx, out), `plain .${format}`);
      ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "round-trip");
      await verifyIndependent(ctx, out, format);
    });
    add(`output.${format}.compress-format-flag-without-extension`, ["output", format], (ctx) => {
      const out = ctx.tmp("out");
      ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out, "--compress-format", format]), `--compress-format ${format}`);
      const produced = fs.readdirSync(ctx.work).find((name) => name.startsWith("out") && name.endsWith(`.${format}`));
      check(produced, () => `no out.${format} produced (have ${fs.readdirSync(ctx.work).join(",")})`);
      ctx.same(ctx.write("rb.bin", readBack(ctx, ctx.tmp(produced))), ctx.fx(TARGET), "round-trip");
    });
    add(`output.${format}.dry-run-writes-nothing`, ["output", format, "dry-run"], (ctx) => {
      const out = ctx.tmp(`out.${format}`);
      ctx.ok(compressed(ctx, out, ["--dry-run"]), "dry-run");
      check(!ctx.exists(out), "dry-run wrote the output");
    });
  }
  add("output.zip.invalid-codec-rejected", ["output", "negative"], (ctx) => {
    ctx.failed(compressed(ctx, ctx.tmp("out.zip"), ["--compress-codec", "bogus"]), { message: /codec/i, what: "bogus zip codec" });
  });
  add("output.7z.unsupported-codec-rejected", ["output", "negative"], (ctx) => {
    ctx.failed(compressed(ctx, ctx.tmp("out.7z"), ["--compress-codec", "deflate"]), { message: /codec/i, what: "deflate in 7z" });
  });
  add("output.zip.invalid-level-rejected", ["output", "negative"], (ctx) => {
    ctx.failed(compressed(ctx, ctx.tmp("out.zip"), ["--compress-level", "11"]), { codes: [2], what: "numeric level" });
  });
  add("output.zip.codec-colon-level-syntax", ["output", "zip"], (ctx) => {
    const out = ctx.tmp("out.zip");
    ctx.ok(compressed(ctx, out, ["--compress-codec", "zstd:19"]), "zstd:19");
    ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "round-trip");
  });
  add("output.format-extension-conflict-flag-wins", ["output", "zip"], (ctx) => {
    const out = ctx.tmp("out.7z");
    const result = ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out, "--compress-format", "zip"]);
    ctx.ok(result, "--compress-format zip with .7z");
    check(/does not match|warning/i.test(result.all), "no mismatch warning printed");
    check(fs.readFileSync(out).subarray(0, 2).toString() === "PK", "flag did not win: output is not a zip");
  });
  add("output.no-compress-with-compress-format-conflict", ["output", "negative"], (ctx) => {
    const result = ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", ctx.tmp("out.zip"), "--no-compress", "--compress-format", "zip"]);
    check(!result.panic, () => ctx.describe(result));
  });

  // -------------------------------------------------------------------------- CHD outputs
  for (const codec of ["store", "zlib", "zstd", "lzma", "huff", "flac"]) {
    add(`output.chd.codec-${codec}`, ["output", "chd", codec], (ctx) => {
      const out = ctx.tmp("out.chd");
      ctx.ok(compressed(ctx, out, ["--compress-codec", codec]), `chd ${codec}`);
      ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "CHD round-trip");
    });
    add(`output.chd.codec-${codec}.determinism`, ["output", "chd", "determinism", codec], (ctx) => {
      const outputs = [];
      for (const [label, threads] of [["a", "1"], ["b", "1"], ["c", "4"], ["d", "16"]]) {
        const out = ctx.tmp(`${label}/out.chd`);
        ctx.ok(compressed(ctx, out, ["--compress-codec", codec, "--threads", threads]), `chd ${codec} -j${threads}`);
        outputs.push(out);
      }
      for (const out of outputs.slice(1)) ctx.same(out, outputs[0], `${path.relative(ctx.work, out)} vs first`);
    });
  }
  for (const level of LEVELS) {
    add(`output.chd.level-${level}`, ["output", "chd", level], (ctx) => {
      const out = ctx.tmp("out.chd");
      ctx.ok(compressed(ctx, out, ["--compress-level", level]), `chd level ${level}`);
      ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "CHD round-trip");
    });
  }
  add("output.chd.cd-codec-on-raw-media-rejected", ["output", "chd", "negative"], (ctx) => {
    ctx.failed(compressed(ctx, ctx.tmp("out.chd"), ["--compress-codec", "cdzs"]), { message: /codec|raw/i, what: "cdzs for raw media" });
  });
  add("output.chd.reference-chdman", ["output", "chd", "reference"], () => {
    if (!have("chdman")) skip("chdman not installed on this host; parity vs chdman is asserted by Rust cli_smoke chd.rs and `mise run quality-reference` where chdman exists");
  });

  // ------------------------------------------------------------------- z3ds / rvz outputs
  add("output.z3ds.round-trip", ["output", "z3ds"], (ctx) => {
    const out = ctx.tmp("out.z3ds");
    ctx.ok(compressed(ctx, out), "z3ds");
    ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "z3ds round-trip");
  });
  for (const level of ["min", "medium", "max"]) {
    add(`output.z3ds.level-${level}`, ["output", "z3ds", level], (ctx) => {
      const out = ctx.tmp("out.z3ds");
      ctx.ok(compressed(ctx, out, ["--compress-level", level]), `z3ds ${level}`);
      ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "z3ds round-trip");
    });
  }
  add("output.z3ds.determinism", ["output", "z3ds", "determinism"], (ctx) => {
    const outputs = [];
    for (const [label, threads] of [["a", "1"], ["b", "1"], ["c", "4"], ["d", "16"]]) {
      const out = ctx.tmp(`${label}/out.z3ds`);
      ctx.ok(compressed(ctx, out, ["--threads", threads]), `z3ds -j${threads}`);
      outputs.push(out);
    }
    for (const out of outputs.slice(1)) ctx.same(out, outputs[0], `${path.relative(ctx.work, out)} vs first`);
  });
  add("output.z3ds.subtype-extensions", ["output", "z3ds"], (ctx) => {
    for (const ext of ["zcci", "zcxi", "zcia", "z3dsx"]) {
      const out = ctx.tmp(`out.${ext}`);
      const result = compressed(ctx, out);
      check(!result.panic, () => ctx.describe(result));
      if (result.code === 0) ctx.same(ctx.write(`rb-${ext}.bin`, readBack(ctx, out, ext)), ctx.fx(TARGET), `${ext} round-trip`);
    }
  });
  add("output.rvz.raw-rom-rejected-with-clear-error", ["output", "rvz", "negative"], (ctx) => {
    const out = ctx.tmp("out.rvz");
    ctx.failed(compressed(ctx, out), { message: /disc|GameCube|Wii/i, what: "rvz from a non-disc ROM" });
    check(!ctx.exists(out), "left a partial rvz");
  });
  const wbfsPatch = ["disc/wbfs.wbfs", "disc/wbfs.ips"];
  add("output.rvz.from-disc-input.round-trip", ["output", "rvz"], (ctx) => {
    const out = ctx.tmp("out.rvz");
    ctx.ok(compressed(ctx, out, [], { rom: wbfsPatch[0], patch: wbfsPatch[1] }), "wbfs -> rvz");
    ctx.same(ctx.write("rb.iso", readBack(ctx, out)), ctx.fx("disc/wbfs.target.iso"), "rvz round-trip");
  });
  for (const level of ["min", "medium", "max"]) {
    add(`output.rvz.level-${level}`, ["output", "rvz", level], (ctx) => {
      const out = ctx.tmp("out.rvz");
      ctx.ok(compressed(ctx, out, ["--compress-level", level], { rom: wbfsPatch[0], patch: wbfsPatch[1] }), `rvz ${level}`);
      ctx.same(ctx.write("rb.iso", readBack(ctx, out)), ctx.fx("disc/wbfs.target.iso"), "rvz round-trip");
    });
  }
  add("output.rvz.determinism", ["output", "rvz", "determinism"], (ctx) => {
    const outputs = [];
    for (const [label, threads] of [["a", "1"], ["b", "1"], ["c", "4"], ["d", "16"]]) {
      const out = ctx.tmp(`${label}/out.rvz`);
      ctx.ok(compressed(ctx, out, ["--threads", threads], { rom: wbfsPatch[0], patch: wbfsPatch[1] }), `rvz -j${threads}`);
      outputs.push(out);
    }
    for (const out of outputs.slice(1)) ctx.same(out, outputs[0], `${path.relative(ctx.work, out)} vs first`);
  });
  add("output.rvz.reference-dolphin-tool", ["output", "rvz", "reference"], () => {
    if (!have("dolphin-tool")) skip("dolphin-tool not installed on this host; RVZ parity vs dolphin-tool is asserted by Rust rvz_z3ds.rs and `mise run quality-reference` where available");
  });
  add("output.disc.default-output-is-raw-iso", ["output", "disc"], (ctx) => {
    const input = ctx.write("in.wbfs", fs.readFileSync(ctx.fx("disc/wbfs.wbfs")));
    ctx.ok(ctx.run(["patch", "apply", "--input", input, "--patch", ctx.fx("disc/wbfs.ips")]), "disc input without --output");
    const produced = fs.readdirSync(ctx.work).filter((name) => /patched/.test(name));
    check(produced.length === 1, () => `expected one default-named output, got ${produced.join(",")}`);
    ctx.same(ctx.tmp(produced[0]), ctx.fx("disc/wbfs.target.iso"), "default disc output");
  });
  for (const ext of ["zip", "7z", "chd", "z3ds"]) {
    add(`output.disc.wbfs-to-${ext}`, ["output", "disc", ext], (ctx) => {
      const out = ctx.tmp(`out.${ext}`);
      ctx.ok(compressed(ctx, out, [], { rom: wbfsPatch[0], patch: wbfsPatch[1] }), `wbfs -> ${ext}`);
      ctx.same(ctx.write("rb.iso", readBack(ctx, out)), ctx.fx("disc/wbfs.target.iso"), `${ext} round-trip`);
    });
  }
  add("output.split.not-offered-by-patch-apply", ["output", "split"], () => {
    skip("patch apply has no split-output option (split WBFS is covered as an input in container.disc.wbfs-split*)");
  });

  // ------------------------------------------------------------------ cue/gdi disc output
  const writeCd = (ctx) => {
    const track1 = Buffer.from(Array.from({ length: 8 * 2352 }, (_, i) => i % 211));
    const track2 = Buffer.from(Array.from({ length: 8 * 2352 }, (_, i) => i % 173));
    ctx.write("track01.bin", track1);
    ctx.write("track02.bin", track2);
    ctx.write("disc.cue", 'FILE "track01.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE "track02.bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
    return [track1, track2];
  };
  const ipsAt = (offset, data) => Buffer.concat([Buffer.from("PATCH"), Buffer.from([(offset >> 16) & 255, (offset >> 8) & 255, offset & 255, 0, data.length]), Buffer.from(data), Buffer.from("EOF")]);
  add("output.disc.cue-target-to-chd", ["output", "disc", "chd", "cue"], (ctx) => {
    const [track1, track2] = writeCd(ctx);
    const patch = ctx.write("p.ips", ipsAt(100, Buffer.alloc(32, 0xc3)));
    const out = ctx.tmp("out.chd");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.tmp("disc.cue"), "--patch", patch, "--target", "track02.bin", "--output", out]), "cue --target -> chd");
    const dir = ctx.tmp("ex");
    ctx.ok(ctx.run(["extract", "--input", out, "--output", dir]), "extract chd");
    const bins = fs.readdirSync(dir).filter((name) => /\.bin$/i.test(name)).sort();
    check(bins.length >= 1, () => `no bin extracted: ${fs.readdirSync(dir).join(",")}`);
    const joined = Buffer.concat(bins.map((name) => fs.readFileSync(path.join(dir, name))));
    const expected = Buffer.from(track2);
    expected.fill(0xc3, 100, 132);
    check(joined.equals(Buffer.concat([track1, expected])), "extracted CHD tracks != original track 1 + patched track 2");
  });
  add("output.disc.cue-multi-track-requires-target", ["output", "disc", "negative"], (ctx) => {
    writeCd(ctx);
    const patch = ctx.write("p.ips", ipsAt(100, Buffer.alloc(8, 1)));
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.tmp("disc.cue"), "--patch", patch, "--output", ctx.tmp("out.chd")]), { message: /target|track/i, what: "multi-track cue without --target" });
  });
  add("output.disc.cue-no-compress-writes-full-disc", ["output", "disc", "cue"], (ctx) => {
    const [track1, track2] = writeCd(ctx);
    const patch = ctx.write("p.ips", ipsAt(100, Buffer.alloc(32, 0xc3)));
    fs.mkdirSync(ctx.tmp("outdir"), { recursive: true });
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.tmp("disc.cue"), "--patch", patch, "--target", "track02.bin", "--output", ctx.tmp("outdir/patched.cue"), "--no-compress"]), "cue --no-compress");
    const files = fs.readdirSync(ctx.tmp("outdir")).sort();
    check(files.some((name) => name.endsWith(".cue")), () => `no cue written: ${files.join(",")}`);
    const bins = files.filter((name) => name.endsWith(".bin"));
    check(bins.length === 2, () => `expected two bins, got ${files.join(",")}`);
    const expected = Buffer.from(track2);
    expected.fill(0xc3, 100, 132);
    const contents = bins.map((name) => fs.readFileSync(path.join(ctx.tmp("outdir"), name)));
    check(contents.some((buf) => buf.equals(track1)), "untouched track changed");
    check(contents.some((buf) => buf.equals(expected)), "patched track missing");
  });

  // ---------------------------------------------------------- output-path edge cases
  add("output-path.unicode-and-spaces", ["output-path"], (ctx) => {
    const out = ctx.tmp("dir é ゲーム/patched ☃ ü.bin");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), "unicode output path");
    ctx.same(out, ctx.fx(TARGET), "output");
  });
  add("output-path.unicode-input-and-patch-names", ["output-path"], (ctx) => {
    const rom = ctx.write("ゲーム é.bin", fs.readFileSync(ctx.fx(ROM)));
    const patch = ctx.write("パッチ ü.ips", fs.readFileSync(ctx.fx(PATCH)));
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(rom, patch, out), "unicode input/patch names");
    ctx.same(out, ctx.fx(TARGET), "output");
  });
  add("output-path.default-name-unicode-stem", ["output-path"], (ctx) => {
    const rom = ctx.write("ゲーム.bin", fs.readFileSync(ctx.fx(ROM)));
    ctx.ok(ctx.run(["patch", "apply", "--input", rom, "--patch", ctx.fx(PATCH)]), "no --output with a unicode stem");
    check(ctx.exists(ctx.tmp("ゲーム-patched.bin")), () => `expected ゲーム-patched.bin, have ${fs.readdirSync(ctx.work).join(",")}`);
  });
  add("output-path.existing-file-refused-then-forced", ["output-path"], (ctx) => {
    const out = ctx.write("existing.bin", "keep me");
    ctx.failed(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out), { message: /exist|force|overwrite/i, what: "existing output" });
    check(fs.readFileSync(out, "utf8") === "keep me", "existing file modified");
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out, ["--force"]), "--force");
    ctx.same(out, ctx.fx(TARGET), "overwritten output");
  });
  add("output-path.existing-compressed-file-refused-then-forced", ["output-path"], (ctx) => {
    const out = ctx.write("existing.zip", "keep me");
    ctx.failed(compressed(ctx, out), { message: /exist|force|overwrite/i, what: "existing zip output" });
    check(fs.readFileSync(out, "utf8") === "keep me", "existing zip modified");
    ctx.ok(compressed(ctx, out, ["--force"]), "--force zip");
    ctx.same(ctx.write("rb.bin", readBack(ctx, out)), ctx.fx(TARGET), "overwritten zip");
  });
  add("output-path.force-preserves-inode-of-existing-output", ["output-path"], (ctx) => {
    const out = ctx.write("existing.bin", "x".repeat(10));
    fs.chmodSync(out, 0o640);
    const before = fs.statSync(out);
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out, ["--force"]), "--force over existing");
    const after = fs.statSync(out);
    check(after.ino === before.ino, "inode changed (existing outputs must keep their identity)");
    check((after.mode & 0o777) === 0o640, () => `mode changed to ${(after.mode & 0o777).toString(8)}`);
  });
  add("output-path.missing-parent-directory", ["output-path"], (ctx) => {
    const out = ctx.tmp("does/not/exist/out.bin");
    fs.rmSync(ctx.tmp("does"), { recursive: true, force: true });
    const result = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out);
    check(!result.panic, () => ctx.describe(result));
    if (result.code === 0) ctx.same(out, ctx.fx(TARGET), "output in a created directory");
    else ctx.failed(result, { message: /director|exist|No such|parent/i, what: "missing parent directory" });
  });
  add("output-path.output-is-a-directory", ["output-path", "negative"], (ctx) => {
    const dir = ctx.tmp("outdir.bin");
    fs.mkdirSync(dir);
    ctx.failed(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), dir, ["--force"]), { what: "output path is a directory" });
    check(fs.statSync(dir).isDirectory(), "directory was replaced");
  });
  add("output-path.output-equals-input", ["output-path", "negative"], (ctx) => {
    const rom = ctx.write("in.bin", fs.readFileSync(ctx.fx(ROM)));
    const result = ctx.apply(rom, ctx.fx(PATCH), rom, ["--force"]);
    check(!result.panic, () => ctx.describe(result));
    // Overwriting the source in place would corrupt a streaming read; the product must refuse or produce the correct result.
    if (result.code === 0) ctx.same(rom, ctx.fx(TARGET), "in-place output");
    else check(fs.readFileSync(rom).equals(fs.readFileSync(ctx.fx(ROM))), "refused apply still modified the input");
  });
  add("output-path.output-equals-patch", ["output-path", "negative"], (ctx) => {
    const patch = ctx.write("p.ips", fs.readFileSync(ctx.fx(PATCH)));
    const result = ctx.apply(ctx.fx(ROM), patch, patch, ["--force"]);
    ctx.failed(result, { what: "output equals patch" });
    check(fs.readFileSync(patch).equals(fs.readFileSync(ctx.fx(PATCH))), "patch file was clobbered");
  });
  add("output-path.very-long-name", ["output-path", "negative"], (ctx) => {
    const out = ctx.tmp(`${"a".repeat(300)}.bin`);
    const result = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out);
    ctx.failed(result, { what: "300-char file name" });
  });
  add("output-path.relative-output-and-cwd", ["output-path"], (ctx) => {
    fs.mkdirSync(ctx.tmp("sub"));
    const result = ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", "../rel.bin", "--no-compress"], { cwd: ctx.tmp("sub") });
    ctx.ok(result, "relative output");
    ctx.same(ctx.tmp("rel.bin"), ctx.fx(TARGET), "relative output");
  });
  add("output-path.symlink-output-target", ["output-path"], (ctx) => {
    const real = ctx.write("real.bin", "old");
    const link = ctx.tmp("link.bin");
    fs.symlinkSync(real, link);
    const refused = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), link);
    check(!refused.panic, () => ctx.describe(refused));
    ctx.ok(ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), link, ["--force"]), "--force through a symlink");
    ctx.same(link, ctx.fx(TARGET), "content visible through the link");
    check(fs.lstatSync(link).isSymbolicLink(), "symlink was replaced by a regular file");
  });
  add("output-path.read-only-directory", ["output-path", "permissions", "negative"], (ctx) => {
    if (process.getuid?.() === 0) skip("running as root: directory permissions are not enforced");
    const dir = ctx.tmp("ro");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o555);
    try {
      const result = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), path.join(dir, "out.bin"));
      ctx.failed(result, { message: /permission|denied|writ/i, what: "read-only output directory" });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
  add("output-path.read-only-existing-output-with-force", ["output-path", "permissions"], (ctx) => {
    if (process.getuid?.() === 0) skip("running as root: file permissions are not enforced");
    const out = ctx.write("ro.bin", "old");
    fs.chmodSync(out, 0o444);
    const result = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), out, ["--force"]);
    check(!result.panic, () => ctx.describe(result));
    if (result.code === 0) ctx.same(out, ctx.fx(TARGET), "forced over read-only");
    else ctx.failed(result, { message: /permission|denied|read-only/i, what: "read-only output" });
  });
  add("output-path.unreadable-input", ["output-path", "permissions", "negative"], (ctx) => {
    if (process.getuid?.() === 0) skip("running as root: file permissions are not enforced");
    const rom = ctx.write("secret.bin", fs.readFileSync(ctx.fx(ROM)));
    fs.chmodSync(rom, 0o000);
    try {
      const out = ctx.tmp("out.bin");
      ctx.failed(ctx.apply(rom, ctx.fx(PATCH), out), { message: /permission|denied/i, what: "unreadable ROM" });
      check(!ctx.exists(out), "left an output");
    } finally {
      fs.chmodSync(rom, 0o644);
    }
  });
  add("output-path.missing-input-and-patch", ["output-path", "negative"], (ctx) => {
    ctx.failed(ctx.apply(ctx.tmp("nope.bin"), ctx.fx(PATCH), ctx.tmp("o1.bin")), { message: /does not exist|No such/i, what: "missing ROM" });
    ctx.failed(ctx.apply(ctx.fx(ROM), ctx.tmp("nope.ips"), ctx.tmp("o2.bin")), { message: /does not exist|No such/i, what: "missing patch" });
  });
  add("output-path.input-is-a-directory", ["output-path", "negative"], (ctx) => {
    fs.mkdirSync(ctx.tmp("adir"));
    ctx.failed(ctx.apply(ctx.tmp("adir"), ctx.fx(PATCH), ctx.tmp("o.bin")), { what: "directory as ROM" });
  });
  add("output-path.empty-rom", ["output-path", "negative"], (ctx) => {
    const rom = ctx.write("empty.bin", new Uint8Array(0));
    const result = ctx.apply(rom, ctx.fx(PATCH), ctx.tmp("o.bin"));
    check(!result.panic, () => ctx.describe(result));
  });
  add("output-path.tmpdir-unwritable-does-not-crash", ["output-path", "permissions"], (ctx) => {
    const result = ctx.apply(ctx.fx(ROM), ctx.fx(PATCH), ctx.tmp("o.bin"), [], { env: { TMPDIR: path.join(os.tmpdir(), "definitely-missing-dir") } });
    check(!result.panic, () => ctx.describe(result));
  });
  add("output-path.json-reports-emitted-file", ["output-path", "report"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const doc = ctx.json(ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx(ROM), "--patch", ctx.fx(PATCH), "--output", out, "--no-compress", "--json"]), "json"));
    const emitted = doc.details?.emitted_files?.[0];
    check(emitted && emitted.path === out && emitted.size_bytes === fs.statSync(out).size, () => `emitted_files wrong: ${JSON.stringify(doc.details?.emitted_files)}`);
  });
};
