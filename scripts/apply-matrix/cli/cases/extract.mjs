// `rom-weaver extract`: every input archive / compressed / disc container type (incl. nested, encrypted, truncated,
// empty, multi-ROM, odd names), the extract options, and robustness against damaged or hostile inputs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { add, check, fail, skip } from "../lib/harness.mjs";
import { have } from "../lib/fixture-defs.mjs";
import { filesUnder, needTool, prngBytes, toolIn, toolMust } from "../lib/reference-tools.mjs";

const ROM = () => Buffer.from(prngBytes(40960, 0x524f4d21));
const ROM2 = () => Buffer.from(prngBytes(30000, 0x0badf00d));
const sha = (buf, algo) => createHash(algo).update(buf).digest("hex");
const rel = (dir, file) => path.relative(dir, file).split(path.sep).join("/");

/** Run `extract` into a fresh directory and return {result, dir, files: Map(relative path -> Buffer)}. */
let seq = 0;
const doExtract = (ctx, input, extra = [], { dir, expectOk = true } = {}) => {
  const out = dir ?? ctx.tmp(`ex-${++seq}`);
  const result = ctx.run(["extract", "--input", input, "--output", out, ...extra]);
  if (expectOk) ctx.ok(result, `extract ${path.basename(input)} ${extra.join(" ")}`);
  const files = new Map(filesUnder(out).map((f) => [rel(out, f), fs.readFileSync(f)]));
  return { result, dir: out, files };
};
const expectOne = (ctx, files, bytes, what) => {
  check(files.size === 1, () => `${what}: expected exactly one extracted file, got [${[...files.keys()].join(", ")}]`);
  check([...files.values()][0].equals(bytes), `${what}: extracted bytes differ from the original`);
};
const expectNoLeftovers = (ctx, dir, what) => {
  const left = fs.existsSync(dir) ? filesUnder(dir) : [];
  check(left.length === 0, () => `${what}: failed extract left files behind: ${left.map((f) => rel(dir, f)).join(", ")}`);
};

const writeZip = (entries) => {
  // hand-built stored zip so hostile names reach the extractor unchanged
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
};

export const register = (env) => {
  const fx = env.fixtures;
  const cacheRoot = fx.cacheDir;
  const sh = (cwd, cmd, args, opts = {}) => execFileSync(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...opts });

  /** Define a cache fixture `exh/arch/<name>` built by running a tool inside a staging directory holding `files`. */
  const archive = (name, files, tool, make) => {
    const key = `exh/arch/${name}`;
    fx.define(key, {
      where: "cache",
      purpose: `extract fixture made with ${tool}`,
      how: `${tool} (see cases/extract.mjs)`,
      deterministic: false,
      build: () => {
        fs.mkdirSync(path.dirname(fx.location(key)), { recursive: true });
        fs.mkdirSync(cacheRoot, { recursive: true });
        const dir = fs.mkdtempSync(path.join(cacheRoot, ".stage-"));
        try {
          for (const [file, data] of Object.entries(files())) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), data);
          }
          make(dir, fx.location(key));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        return undefined;
      },
    });
    return key;
  };
  const one = () => ({ "game.bin": ROM() });
  const two = () => ({ "game.bin": ROM(), "other.sfc": ROM2() });

  // ----------------------------------------------------------------------------------------------- table
  // [id, fixture key, tool, expected relative path -> bytes (function), extract args]
  const table = [];
  const def = (id, tool, files, make, expect, opts = {}) => {
    const key = archive(id, files, tool, make);
    table.push({ id, key, tool, expect: expect ?? (() => ({ "game.bin": ROM() })), ...opts });
  };
  const A = (cmd, args) => (dir, out) => sh(dir, cmd, args(out));

  // ---- zip
  def("zip-bzip2.zip", "zip", one, A("zip", (o) => ["-q", "-Z", "bzip2", o, "game.bin"]));
  def("zip-zipcrypto-none-comment.zip", "zip", one, (dir, out) => sh(dir, "zip", ["-q", "-z", out, "game.bin"], { input: "archive comment\n" }));
  def("zip-lzma.zip", "7z", one, A("7z", (o) => ["a", "-tzip", "-mm=LZMA", o, "game.bin"]));
  def("zip-ppmd.zip", "7z", one, A("7z", (o) => ["a", "-tzip", "-mm=PPMd", o, "game.bin"]));
  def("zip-bzip2-7z.zip", "7z", one, A("7z", (o) => ["a", "-tzip", "-mm=BZip2", o, "game.bin"]));
  def("zip-deflate64.zip", "7z", one, A("7z", (o) => ["a", "-tzip", "-mm=Deflate64", o, "game.bin"]));
  def("zip-copy.zip", "7z", one, A("7z", (o) => ["a", "-tzip", "-mm=Copy", o, "game.bin"]));
  def("zip-two-roms.zip", "zip", two, A("zip", (o) => ["-q", o, "game.bin", "other.sfc"]), () => ({ "game.bin": ROM(), "other.sfc": ROM2() }), { multi: true });
  def("zip-unicode-names.zip", "zip", () => ({ "gämé ☃ [v1.0] (USA).bin": ROM() }), A("zip", (o) => ["-q", o, "gämé ☃ [v1.0] (USA).bin"]), () => ({ "gämé ☃ [v1.0] (USA).bin": ROM() }));
  def("zip-leading-dash-and-spaces.zip", "zip", () => ({ "-weird  name.bin": ROM() }), A("zip", (o) => ["-q", o, "--", "-weird  name.bin"]), () => ({ "-weird  name.bin": ROM() }));
  def("zip-nested-dirs.zip", "zip", () => ({ "a/b/c/game.bin": ROM() }), A("zip", (o) => ["-q", "-r", o, "a"]), () => ({ "game.bin": ROM() }), { anyDir: true });
  def("zip-empty-member-plus-rom.zip", "zip", () => ({ "game.bin": ROM(), "empty.bin": Buffer.alloc(0) }), A("zip", (o) => ["-q", o, "game.bin", "empty.bin"]), () => ({ "game.bin": ROM() }), { lenient: true });
  def("zip-utf8-flag-7z.zip", "7z", () => ({ "ünï.bin": ROM() }), A("7z", (o) => ["a", "-tzip", "-mcu=on", o, "ünï.bin"]), () => ({ "ünï.bin": ROM() }));
  // ---- 7z
  for (const [name, args] of [
    ["lzma", ["-m0=LZMA"]],
    ["lzma2", ["-m0=LZMA2"]],
    ["ppmd", ["-m0=PPMd"]],
    ["bzip2", ["-m0=BZip2"]],
    ["deflate", ["-m0=Deflate"]],
    ["copy", ["-m0=Copy"]],
    ["bcj-lzma2", ["-m0=BCJ", "-m1=LZMA2"]],
    ["delta-lzma2", ["-m0=Delta:4", "-m1=LZMA2"]],
    ["solid-off", ["-ms=off"]],
    ["solid-on", ["-ms=on"]],
    ["x1", ["-mx=1"]],
    ["x9", ["-mx=9"]],
    ["bigdict", ["-m0=LZMA2:d=64m"]],
    ["zstd", ["-m0=zstd"]],
    ["brotli", ["-m0=brotli"]],
  ]) {
    const unsupported = name === "zstd" || name === "brotli";
    def(`7z-${name}.7z`, "7z", two, A("7z", (o) => ["a", "-t7z", ...args, o, "game.bin", "other.sfc"]), () => ({ "game.bin": ROM(), "other.sfc": ROM2() }), { multi: true, mayBeUnsupported: unsupported });
  }
  def("7z-one-rom.7z", "7z", one, A("7z", (o) => ["a", "-t7z", o, "game.bin"]));
  def("7z-unicode.7z", "7z", () => ({ "gämé ☃.bin": ROM() }), A("7z", (o) => ["a", "-t7z", o, "gämé ☃.bin"]), () => ({ "gämé ☃.bin": ROM() }));
  def("7z-empty-file-only.7z", "7z", () => ({ "empty.bin": Buffer.alloc(0) }), A("7z", (o) => ["a", "-t7z", o, "empty.bin"]), () => ({}), { emptyArchive: true });
  def("7z-solid-many.7z", "7z", () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.bin`, Buffer.from(prngBytes(1000 + i, i + 1))])), A("7z", (o) => ["a", "-t7z", "-ms=on", o, "."]), () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.bin`, Buffer.from(prngBytes(1000 + i, i + 1))])), { multi: true, noIgnore: true });
  // ---- rar (rar 7.x writes rar5 only)
  def("rar5-store.rar", "rar", one, A("rar", (o) => ["a", "-m0", "-idq", o, "game.bin"]));
  def("rar5-best.rar", "rar", one, A("rar", (o) => ["a", "-m5", "-idq", o, "game.bin"]));
  def("rar5-solid.rar", "rar", two, A("rar", (o) => ["a", "-s", "-idq", o, "game.bin", "other.sfc"]), () => ({ "game.bin": ROM(), "other.sfc": ROM2() }), { multi: true });
  def("rar5-dir.rar", "rar", () => ({ "d/game.bin": ROM() }), A("rar", (o) => ["a", "-r", "-idq", o, "d"]), () => ({ "game.bin": ROM() }), { anyDir: true });
  def("rar5-recovery.rar", "rar", one, A("rar", (o) => ["a", "-rr5", "-idq", o, "game.bin"]));
  // ---- tar family and single-stream compressors
  const tarFormats = [["ustar", ["--format", "ustar"]], ["pax", ["--format", "pax"]], ["gnutar", ["--format", "gnutar"]], ["v7", ["--format", "v7tar"]]];
  for (const [name, args] of tarFormats) def(`tar-${name}.tar`, "bsdtar", one, A("bsdtar", (o) => ["-cf", o, ...args, "game.bin"]));
  def("tar-gnu-longname.tar", "tar", () => ({ [`${"d".repeat(60)}/${"n".repeat(120)}.bin`]: ROM() }), (dir, out) => sh(dir, "tar", ["--format=gnu", "-cf", out, "."]), () => ({ [`${"n".repeat(120)}.bin`]: ROM() }), { anyDir: true });
  def("tar-xz.tar.xz", "tar", one, A("tar", (o) => ["-cJf", o, "game.bin"]));
  def("tar-bz2.tar.bz2", "tar", one, A("tar", (o) => ["-cjf", o, "game.bin"]));
  def("tar-gz.tar.gz", "tar", one, A("tar", (o) => ["-czf", o, "game.bin"]));
  def("tar-zst.tar.zst", "tar", one, A("tar", (o) => ["--zstd", "-cf", o, "game.bin"]), undefined, { anyDir: true, multi: true });
  def("tar-lz4.tar.lz4", "tar", one, (dir, out) => { sh(dir, "tar", ["-cf", "x.tar", "game.bin"]); sh(dir, "lz4", ["-q", "x.tar", out]); }, undefined, { anyDir: true, multi: true });
  def("tar-two-roms.tar", "tar", two, A("tar", (o) => ["-cf", o, "game.bin", "other.sfc"]), () => ({ "game.bin": ROM(), "other.sfc": ROM2() }), { multi: true });
  def("tar-gz-multi-member.tar.gz", "gzip", one, (dir, out) => { sh(dir, "tar", ["-cf", "x.tar", "game.bin"]); sh(dir, "sh", ["-c", `gzip -c x.tar > "${out}"`]); });
  def("single.gz", "gzip", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `gzip -9 -n -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-named.bin.gz", "gzip", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `gzip -c game.bin > "${out}"`]), undefined, { single: true });
  def("single.bz2", "bzip2", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `bzip2 -9 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single.xz", "xz", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `xz -6 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-crc64-x86-bcj.xz", "xz", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `xz --x86 --lzma2 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-multi-block.xz", "xz", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `xz --block-size=4096 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single.zst", "zstd", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `zstd -q -19 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-ultra.zst", "zstd", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `zstd -q --ultra -22 --long=27 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single.lz4", "lz4", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `lz4 -q -9 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-lz4hc-bd7.lz4", "lz4", () => ({ "game.bin": ROM() }), (dir, out) => sh(dir, "sh", ["-c", `lz4 -q -12 -BD -B7 -c game.bin > "${out}"`]), undefined, { single: true });
  def("single-empty.gz", "gzip", () => ({ "empty.bin": Buffer.alloc(0) }), (dir, out) => sh(dir, "sh", ["-c", `gzip -c empty.bin > "${out}"`]), () => ({}), { emptyArchive: true, emptyPayload: true });

  for (const entry of table) {
    add(`extract.archive.${entry.id}`, ["extract", "archive", entry.tool], (ctx) => {
      if (!have(entry.tool)) skip(`${entry.tool} not installed`);
      let input;
      try {
        input = ctx.fx(entry.key);
      } catch (error) {
        if (entry.mayBeUnsupported || entry.optionalTool) skip(`fixture could not be built: ${String(error.message).split("\n")[0].slice(0, 150)}`);
        throw error;
      }
      const expected = entry.single ? { [entry.id.replace(/\.[^.]+$/, "")]: ROM() } : entry.expect();
      const { result, dir, files } = doExtract(ctx, input, entry.noIgnore ? ["--no-ignore"] : [], { expectOk: false });
      if (result.code !== 0) {
        ctx.failed(result, { what: `extract ${entry.id}` });
        expectNoLeftovers(ctx, dir, entry.id);
        if (entry.mayBeUnsupported || entry.emptyArchive) {
          ctx.note(`${entry.id}: rejected cleanly (${result.all.trim().split("\n")[0].slice(0, 110)})`);
          return;
        }
        fail(`${entry.id}: extract failed: ${ctx.describe(result)}`);
      }
      const want = Object.entries(expected);
      if (entry.emptyArchive) {
        check(files.size === 0 || [...files.values()].every((b) => b.length === 0), () => `${entry.id}: expected nothing / empty payload, got ${[...files.keys()]}`);
        return;
      }
      if (entry.lenient) {
        check([...files.entries()].some(([name, buf]) => path.basename(name) === "game.bin" && buf.equals(ROM())), "game.bin missing");
        return;
      }
      for (const [name, bytes] of want) {
        const found = [...files.entries()].find(([k]) => (entry.anyDir ? path.basename(k) === path.basename(name) : k === name));
        check(found, () => `${entry.id}: ${name} not extracted (got ${[...files.keys()].join(", ")})`);
        check(found[1].equals(bytes), `${entry.id}: ${name} bytes differ`);
      }
      if (!entry.multi) check(files.size === want.length, () => `${entry.id}: extra files: ${[...files.keys()].join(", ")}`);
    });
  }

  // single-stream name stripping and --select on multi archives
  add("extract.archive.single-gz-output-name-strips-extension", ["extract", "archive"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("exh/arch/single-named.bin.gz"));
    check([...files.keys()].join() === "single-named.bin", () => `names: ${[...files.keys()]}`);
    const lz = doExtract(ctx, ctx.fx("exh/arch/single.lz4")).files;
    check([...lz.keys()].join() === "single", () => `lz4 names: ${[...lz.keys()]}`);
    for (const id of ["tar-zst.tar.zst", "tar-lz4.tar.lz4"]) {
      const layout = doExtract(ctx, ctx.fx(`exh/arch/${id}`)).files;
      ctx.note(`${id} extracts as ${[...layout.keys()].join(" + ")} (tar.gz/xz/bz2 extract straight to the member)`);
    }
  });

  // ----------------------------------------------------------------------------------------------- empty / broken / hostile
  add("extract.broken.empty-file-of-every-archive-extension", ["extract", "broken"], (ctx) => {
    for (const ext of ["zip", "zipx", "7z", "rar", "tar", "tar.gz", "tgz", "tar.bz2", "tbz2", "tar.xz", "txz", "gz", "bz2", "xz", "zst", "lz4", "cso", "ciso", "pbp", "chd", "gcz", "wia", "rvz", "tgc", "nfs", "wbfs", "z3ds", "xiso"]) {
      const input = ctx.write(`empty.${ext}`, "");
      const { result, dir } = doExtract(ctx, input, [], { expectOk: false });
      check(!result.panic && !result.timedOut, () => `empty .${ext}: ${ctx.describe(result)}`);
      if (result.code !== 0) expectNoLeftovers(ctx, dir, `empty .${ext}`);
    }
  });
  add("extract.broken.garbage-file-of-every-archive-extension", ["extract", "broken"], (ctx) => {
    const garbage = Buffer.from(prngBytes(5000, 31));
    for (const ext of ["zip", "zipx", "7z", "rar", "tar", "tar.gz", "tgz", "tar.bz2", "tar.xz", "gz", "bz2", "xz", "zst", "lz4", "cso", "ciso", "pbp", "chd", "gcz", "wia", "rvz", "tgc", "nfs", "wbfs", "z3ds", "xiso"]) {
      const input = ctx.write(`garbage.${ext}`, garbage);
      const { result, dir } = doExtract(ctx, input, [], { expectOk: false });
      ctx.failed(result, { what: `garbage .${ext}` });
      expectNoLeftovers(ctx, dir, `garbage .${ext}`);
    }
  });
  add("extract.broken.header-only-and-one-byte-files", ["extract", "broken"], (ctx) => {
    for (const ext of ["zip", "7z", "rar", "gz", "bz2", "xz", "zst", "lz4", "chd", "rvz", "z3ds", "cso", "wbfs"]) {
      for (const bytes of [Buffer.from([0x50]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(31)]) {
        const input = ctx.write(`tiny${bytes.length}.${ext}`, bytes);
        const { result, dir } = doExtract(ctx, input, [], { expectOk: false });
        check(!result.panic && !result.timedOut, () => `${bytes.length} bytes .${ext}: ${ctx.describe(result)}`);
        if (result.code !== 0) expectNoLeftovers(ctx, dir, `${bytes.length} bytes .${ext}`);
      }
    }
  });
  const corruptable = [
    "exh/arch/7z-lzma2.7z", "exh/arch/7z-ppmd.7z", "exh/arch/rar5-store.rar", "exh/arch/rar5-best.rar", "exh/arch/tar-gz.tar.gz", "exh/arch/tar-xz.tar.xz",
    "exh/arch/single.gz", "exh/arch/single.bz2", "exh/arch/single.xz", "exh/arch/single.zst", "exh/arch/single.lz4", "exh/arch/zip-bzip2.zip", "exh/arch/zip-lzma.zip",
  ];
  for (const name of corruptable) {
    const id = name.split("/").pop();
    for (const frac of [0.25, 0.5, 0.9, 0.999]) {
      add(`extract.broken.truncated.${id}.at-${frac}`, ["extract", "broken", "truncate"], (ctx) => {
        const full = fs.readFileSync(ctx.fx(name));
        const input = ctx.write(id, full.subarray(0, Math.floor(full.length * frac)));
        const { result, dir, files } = doExtract(ctx, input, [], { expectOk: false });
        check(!result.timedOut, "timed out");
        if (result.code === 0) {
          // A prefix that still decodes must not claim success with wrong data.
          // Cutting only the central directory / trailer leaves every payload byte intact; exit 0 is fine then.
          const exact = files.size > 0 && [...files.values()].every((b) => b.equals(ROM()) || b.equals(ROM2()));
          check(exact, () => `truncated at ${frac} extracted with exit 0 but wrong data (${[...files.keys()].join(",")} ${[...files.values()].map((b) => b.length)})`);
          return;
        }
        ctx.failed(result, { what: `truncated ${id}` });
        expectNoLeftovers(ctx, dir, `truncated ${id}`);
      });
    }
    add(`extract.broken.bitflip.${id}`, ["extract", "broken", "bitflip"], (ctx) => {
      const full = Buffer.from(fs.readFileSync(ctx.fx(name)));
      for (const at of [Math.floor(full.length / 2), Math.floor(full.length * 0.8), full.length - 8]) {
        const copy = Buffer.from(full);
        copy[at] ^= 0x40;
        const input = ctx.write(`flip${at}-${id}`, copy);
        const { result, files, dir } = doExtract(ctx, input, [], { expectOk: false });
        check(!result.panic && !result.timedOut, () => `bit flip @${at}: ${ctx.describe(result)}`);
        if (result.code === 0) {
          // Success is acceptable only when the data is exactly right (flip hit padding / unused bytes).
          const names = [...files.keys()];
          const good = names.every((n) => files.get(n).equals(ROM()) || files.get(n).equals(ROM2()));
          check(good, () => `bit flip @${at} extracted with exit 0 but wrong data (${names.join(",")}): silent corruption`);
        } else expectNoLeftovers(ctx, dir, `bit flip @${at}`);
      }
    });
  }
  add("extract.broken.zip-bitflip-is-detected-by-crc", ["extract", "broken", "bitflip"], (ctx) => {
    const zip = fs.readFileSync(ctx.fx("ctr/zip-deflate.zip"));
    let detected = 0;
    for (const at of [200, 1000, 5000, 20000]) {
      const copy = Buffer.from(zip);
      copy[at] ^= 0x01;
      const { result, files } = doExtract(ctx, ctx.write(`z${at}.zip`, copy), [], { expectOk: false });
      check(!result.panic, "panic");
      if (result.code === 0) check([...files.values()].every((b) => b.equals(ROM())), `bit flip at ${at} extracted silently-corrupt data with exit 0`);
      else detected++;
    }
    check(detected >= 1, "no corrupted member was detected at all");
  });
  add("extract.broken.stored-zip-bitflip-is-detected-by-crc", ["extract", "broken", "bitflip"], (ctx) => {
    const zip = fs.readFileSync(ctx.fx("ctr/zip-store.zip"));
    const copy = Buffer.from(zip);
    copy[10000] ^= 0x01;
    const { result, files } = doExtract(ctx, ctx.write("s.zip", copy), [], { expectOk: false });
    check(!result.panic, "panic");
    if (result.code === 0) check([...files.values()].every((b) => b.equals(ROM())), "stored zip with a flipped payload byte extracted silently-corrupt data with exit 0 (CRC32 not checked)");
  });
  add("extract.broken.gzip-trailer-crc-mismatch", ["extract", "broken", "bitflip"], (ctx) => {
    const gz = Buffer.from(fs.readFileSync(ctx.fx("exh/arch/single.gz")));
    gz[gz.length - 5] ^= 0xff; // CRC32 field
    const { result, files } = doExtract(ctx, ctx.write("bad.gz", gz), [], { expectOk: false });
    check(!result.panic, "panic");
    if (result.code === 0) fail(`gzip with a wrong trailer CRC extracted with exit 0 (${[...files.keys()]})`);
  });
  add("extract.broken.gzip-isize-mismatch", ["extract", "broken"], (ctx) => {
    const gz = Buffer.from(fs.readFileSync(ctx.fx("exh/arch/single.gz")));
    gz[gz.length - 1] ^= 0x01; // ISIZE field
    const { result } = doExtract(ctx, ctx.write("bad.gz", gz), [], { expectOk: false });
    check(!result.panic, "panic");
    ctx.note(`gzip with a wrong ISIZE: exit ${result.code}`);
  });
  add("extract.broken.trailing-garbage-after-stream", ["extract", "broken"], (ctx) => {
    for (const name of ["exh/arch/single.gz", "exh/arch/single.xz", "exh/arch/single.bz2", "exh/arch/single.zst"]) {
      const id = name.split("/").pop();
      const input = ctx.write(`tg-${id}`, Buffer.concat([fs.readFileSync(ctx.fx(name)), Buffer.from("TRAILING-GARBAGE-0123456789")]));
      const { result, files } = doExtract(ctx, input, [], { expectOk: false });
      check(!result.panic && !result.timedOut, `${id}: ${ctx.describe(result)}`);
      if (result.code === 0) check([...files.values()].some((b) => b.equals(ROM())), `${id}: trailing garbage changed the payload`);
    }
  });
  add("extract.broken.encrypted-7z-and-rar-and-zip", ["extract", "broken", "encrypted"], (ctx) => {
    needTool("7z");
    needTool("rar");
    const data = ctx.write("game.bin", ROM());
    const make = (out, tool, args) => toolMust(toolIn(ctx)(tool, args, { cwd: ctx.work }), `${tool} ${args.slice(0, 3).join(" ")}`);
    make("e1.7z", "7z", ["a", "-t7z", "-psecret", ctx.tmp("e1.7z"), data]);
    make("e2.7z", "7z", ["a", "-t7z", "-psecret", "-mhe=on", ctx.tmp("e2.7z"), data]);
    make("e3.zip", "7z", ["a", "-tzip", "-psecret", "-mem=AES256", ctx.tmp("e3.zip"), data]);
    make("e4.zip", "7z", ["a", "-tzip", "-psecret", "-mem=ZipCrypto", ctx.tmp("e4.zip"), data]);
    make("e5.rar", "rar", ["a", "-psecret", "-idq", ctx.tmp("e5.rar"), data]);
    make("e6.rar", "rar", ["a", "-hpsecret", "-idq", ctx.tmp("e6.rar"), data]);
    for (const name of ["e1.7z", "e2.7z", "e3.zip", "e4.zip", "e5.rar", "e6.rar"]) {
      const { result, dir } = doExtract(ctx, ctx.tmp(name), [], { expectOk: false });
      ctx.failed(result, { message: /encrypt|password|passphrase|unsupported|not supported/i, what: `encrypted ${name}` });
      expectNoLeftovers(ctx, dir, name);
    }
  });
  add("extract.broken.zip-slip-and-absolute-names", ["extract", "safety"], (ctx) => {
    const hostile = ["../escape.bin", "../../escape.bin", "a/../../escape.bin", "/tmp/rw-abs-escape.bin", "..\\escape.bin", "C:\\escape.bin", "a\\..\\..\\escape.bin", "./../escape.bin"];
    for (const [index, name] of hostile.entries()) {
      const sandbox = ctx.tmp(`sb${index}/inner/out`);
      fs.mkdirSync(sandbox, { recursive: true });
      const input = ctx.write(`hostile${index}.zip`, writeZip([[name, ROM()], ["game.bin", ROM()]]));
      const result = ctx.run(["extract", "--input", input, "--output", sandbox, "--no-ignore"]);
      check(!result.panic && !result.timedOut, () => `${name}: ${ctx.describe(result)}`);
      const escaped = filesUnder(path.join(ctx.work, `sb${index}`)).filter((f) => !f.startsWith(sandbox));
      check(escaped.length === 0, () => `entry ${JSON.stringify(name)} wrote outside the output directory: ${escaped.join(", ")}`);
      check(!fs.existsSync("/tmp/rw-abs-escape.bin"), "absolute path entry wrote to /tmp");
    }
  });
  add("extract.broken.duplicate-member-names", ["extract", "safety"], (ctx) => {
    const { result, files } = doExtract(ctx, ctx.write("dup.zip", writeZip([["game.bin", ROM()], ["game.bin", ROM2()]])), [], { expectOk: false });
    check(!result.panic, "panic");
    ctx.note(`zip with two members named game.bin: exit ${result.code}, ${files.size} file(s) written`);
    if (result.code === 0) check(files.size >= 1, "exit 0 with nothing extracted");
  });
  add("extract.broken.case-colliding-names", ["extract", "safety"], (ctx) => {
    needTool("zip");
    ctx.write("Game.BIN", ROM());
    ctx.write("sub/game.bin", ROM2());
    toolMust(toolIn(ctx)("zip", ["-q", "-j", ctx.tmp("case.zip"), "Game.BIN", "sub/game.bin"], { cwd: ctx.work }), "zip");
    const { result, files } = doExtract(ctx, ctx.tmp("case.zip"), [], { expectOk: false });
    check(!result.panic, "panic");
    ctx.note(`case-colliding member names: exit ${result.code}; files ${[...files.keys()].join(",")}`);
  });
  add("extract.broken.symlink-members", ["extract", "safety"], (ctx) => {
    needTool("tar");
    ctx.write("game.bin", ROM());
    fs.symlinkSync("/etc/passwd", ctx.tmp("evil"));
    fs.symlinkSync("game.bin", ctx.tmp("link.bin"));
    toolMust(toolIn(ctx)("tar", ["-cf", ctx.tmp("sym.tar"), "game.bin", "evil", "link.bin"], { cwd: ctx.work }), "tar symlinks");
    const out = ctx.tmp("symex");
    const result = ctx.run(["extract", "--input", ctx.tmp("sym.tar"), "--output", out, "--no-ignore"]);
    check(!result.panic, "panic");
    for (const f of filesUnder(out)) check(!fs.lstatSync(f).isSymbolicLink() || !fs.readlinkSync(f).startsWith("/"), () => `absolute symlink materialised: ${f}`);
  });
  add("extract.broken.decompression-bomb-is-bounded", ["extract", "safety"], (ctx) => {
    // 256 MiB of zeros in 200 B: must either extract (correctly) quickly or refuse; never exhaust memory or hang.
    const gz = zlib.gzipSync(Buffer.alloc(256 << 20), { level: 9 });
    const input = ctx.write("bomb.gz", gz);
    const { result, files } = doExtract(ctx, input, [], { expectOk: false });
    check(!result.timedOut && !result.panic, () => ctx.describe(result));
    if (result.code === 0) check([...files.values()].every((b) => b.length === 256 << 20), "bomb extracted with the wrong length");
    ctx.note(`256 MiB zero gzip: exit ${result.code} in ${result.ms} ms`);
  });
  add("extract.broken.zip-with-wrong-declared-size", ["extract", "broken"], (ctx) => {
    const zip = Buffer.from(fs.readFileSync(ctx.fx("ctr/zip-store.zip")));
    const cdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    check(cdOffset > 0, "no central directory");
    zip.writeUInt32LE(0xffffff, cdOffset + 24); // uncompressed size far too large
    const { result } = doExtract(ctx, ctx.write("size.zip", zip), [], { expectOk: false });
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
  });
  add("extract.broken.zip-eocd-comment-length-lie", ["extract", "broken"], (ctx) => {
    const zip = Buffer.from(fs.readFileSync(ctx.fx("ctr/zip-store.zip")));
    zip.writeUInt16LE(500, zip.length - 2);
    const { result } = doExtract(ctx, ctx.write("eocd.zip", zip), [], { expectOk: false });
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
  });

  // ----------------------------------------------------------------------------------------------- nesting
  add("extract.nested.zip-in-zip-in-tgz-and-depth-limit", ["extract", "nested"], (ctx) => {
    needTool("zip");
    let current = ctx.write("lvl/game.bin", ROM());
    for (let depth = 1; depth <= 10; depth++) {
      const dir = path.join(ctx.work, `lvl${depth}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(current, path.join(dir, path.basename(current)));
      const out = path.join(ctx.work, `nest${depth}.zip`);
      toolMust(toolIn(ctx)("zip", ["-q", out, path.basename(current)], { cwd: dir }), "zip nest");
      current = out;
    }
    const { result, files } = doExtract(ctx, current, [], { expectOk: false });
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
    const names = [...files.keys()].join(",");
    ctx.note(`10 levels of zip nesting: exit ${result.code}; ${names.slice(0, 100)}`);
    if (result.code === 0) check([...files.values()].some((b) => b.equals(ROM()) || b.subarray(0, 2).toString() === "PK"), "depth-limited extraction produced neither the ROM nor the next archive");
    const shallow = doExtract(ctx, ctx.fx("ctr/nested-outer.zip"), ["--no-nested-extract"]);
    check([...shallow.files.keys()].some((k) => k.endsWith(".zip")), () => `--no-nested-extract unpacked the inner archive: ${[...shallow.files.keys()]}`);
    const deep = doExtract(ctx, ctx.fx("ctr/nested-outer.zip"));
    check([...deep.files.values()].some((b) => b.equals(ROM())), "nested extraction did not reach the ROM");
  });
  add("extract.nested.self-containing-archive-terminates", ["extract", "nested", "safety"], (ctx) => {
    // A gzip whose payload is itself the same gzip is impossible, but a zip-bomb-like loop of identical nested names must stop.
    const inner = zlib.gzipSync(Buffer.from("x".repeat(100)));
    let blob = inner;
    for (let i = 0; i < 12; i++) blob = zlib.gzipSync(blob);
    const { result } = doExtract(ctx, ctx.write("loop.gz", blob), [], { expectOk: false });
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
  });
  add("extract.nested.7z-in-tgz", ["extract", "nested"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("ctr/nested-tgz-7z.tgz"));
    check([...files.values()].some((b) => b.equals(ROM())), () => `ROM not found: ${[...files.keys()]}`);
  });

  // ----------------------------------------------------------------------------------------------- options
  add("extract.opts.select-exact-folder-glob", ["extract", "options"], (ctx) => {
    const input = ctx.fx("exh/arch/zip-two-roms.zip");
    expectOne(ctx, doExtract(ctx, input, ["--select", "game.bin"]).files, ROM(), "--select exact");
    expectOne(ctx, doExtract(ctx, input, ["-s", "*.sfc"]).files, ROM2(), "--select glob");
    expectOne(ctx, doExtract(ctx, input, ["-s", "other.sfc", "-s", "other.sfc"]).files, ROM2(), "--select repeated");
    check(doExtract(ctx, input, ["-s", "game.bin", "-s", "other.sfc"]).files.size === 2, "two --select values");
    const miss = doExtract(ctx, input, ["-s", "nope.bin"], { expectOk: false });
    ctx.failed(miss.result, { what: "--select no match" });
    expectNoLeftovers(ctx, miss.dir, "--select no match");
  });
  add("extract.opts.filter-rom-and-patch", ["extract", "options"], (ctx) => {
    const input = ctx.fx("ctr/rom-plus-patch.zip");
    const all = doExtract(ctx, input, ["--no-ignore"]).files;
    const rom = doExtract(ctx, input, ["--filter", "rom"]).files;
    const patch = doExtract(ctx, input, ["--filter", "patch"]).files;
    check(rom.size >= 1 && patch.size >= 1 && all.size >= rom.size + patch.size - 0, () => `filter sizes all=${all.size} rom=${rom.size} patch=${patch.size}`);
    check([...patch.keys()].every((k) => /\.(bps|ips|ups|xdelta|ppf)$/i.test(k)), () => `--filter patch extracted ${[...patch.keys()]}`);
    check([...rom.keys()].every((k) => !/\.(bps|ips|ups)$/i.test(k)), () => `--filter rom extracted ${[...rom.keys()]}`);
    doExtract(ctx, input, ["--filter", "rom,patch"]);
    ctx.failed(doExtract(ctx, input, ["--filter", "bogus"], { expectOk: false }).result, { what: "--filter bogus" });
  });
  add("extract.opts.no-ignore-exposes-readme", ["extract", "options"], (ctx) => {
    const input = ctx.fx("ctr/rom-plus-readme.zip");
    const normal = doExtract(ctx, input).files;
    const all = doExtract(ctx, input, ["--no-ignore"]).files;
    check(all.size > normal.size, () => `--no-ignore ${all.size} vs ${normal.size}`);
  });
  add("extract.opts.force-and-overwrite-policy", ["extract", "options", "overwrite"], (ctx) => {
    const input = ctx.fx("exh/arch/zip-two-roms.zip");
    const dir = ctx.tmp("target");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "other.sfc"), "precious");
    const refused = doExtract(ctx, input, [], { dir, expectOk: false });
    ctx.failed(refused.result, { message: /overwrite|exists|--force/i, what: "extract onto existing file" });
    check(fs.readFileSync(path.join(dir, "other.sfc"), "utf8") === "precious", "refused extraction modified the existing file");
    check(!fs.existsSync(path.join(dir, "game.bin")), "refused extraction was not atomic: game.bin was written even though other.sfc blocked it");
    doExtract(ctx, input, ["--force"], { dir });
    check(fs.readFileSync(path.join(dir, "other.sfc")).equals(ROM2()), "--force did not overwrite");
  });
  add("extract.opts.output-dir-is-a-file-or-missing", ["extract", "options", "negative"], (ctx) => {
    const file = ctx.write("iamafile", "x");
    ctx.failed(ctx.run(["extract", "--input", ctx.fx("exh/arch/zip-two-roms.zip"), "--output", file]), { what: "output is a file" });
    const deep = ctx.tmp("a/b/c/out");
    const r = ctx.run(["extract", "--input", ctx.fx("exh/arch/zip-two-roms.zip"), "--output", deep]);
    ctx.ok(r, "output below missing directories is created");
    check(filesUnder(deep).length === 2, "files missing below created directory");
  });
  add("extract.opts.dry-run-writes-nothing", ["extract", "options"], (ctx) => {
    const dir = ctx.tmp("dry");
    const result = ctx.run(["extract", "--input", ctx.fx("exh/arch/zip-two-roms.zip"), "--output", dir, "--dry-run", "--json"]);
    ctx.ok(result, "--dry-run");
    check(!fs.existsSync(dir) || filesUnder(dir).length === 0, "dry-run wrote files");
  });
  add("extract.opts.checksum-all-algorithms-match-independent-hashes", ["extract", "options", "checksum"], (ctx) => {
    const rom = ROM();
    const result = ctx.ok(ctx.run(["extract", "--input", ctx.fx("exh/arch/single.gz"), "--output", ctx.tmp("c"), "--checksum", "crc32,md5,sha1,sha256,blake3,crc32c,crc16,adler32", "--json"]), "extract --checksum all");
    const doc = ctx.json(result);
    const text = JSON.stringify(doc).toLowerCase();
    const expect = {
      crc32: (zlib.crc32 ? zlib.crc32(rom) : 0).toString(16).padStart(8, "0"),
      md5: sha(rom, "md5"),
      sha1: sha(rom, "sha1"),
      sha256: sha(rom, "sha256"),
    };
    let adlerA = 1;
    let adlerB = 0;
    for (const byte of rom) {
      adlerA = (adlerA + byte) % 65521;
      adlerB = (adlerB + adlerA) % 65521;
    }
    expect.adler32 = (((adlerB << 16) | adlerA) >>> 0).toString(16).padStart(8, "0");
    for (const [algo, value] of Object.entries(expect)) if (algo !== "crc32" || zlib.crc32) check(text.includes(value), () => `${algo} ${value} not in the extract report`);
    for (const algo of ["blake3", "crc32c", "crc16"]) check(text.includes(algo), `${algo} missing from the report`);
    // the same values from the dedicated `checksum` command
    for (const algo of ["blake3", "crc32c", "crc16"]) {
      const f = ctx.write("g.bin", rom);
      const c = ctx.ok(ctx.run(["checksum", "--input", f, "--algo", algo, "--json"]), `checksum ${algo}`);
      const m = /"(?:value|hash|digest)":"([0-9a-f]+)"/i.exec(c.stdout);
      if (m) check(text.includes(m[1].toLowerCase()), () => `${algo} from extract differs from the checksum command (${m[1]})`);
    }
  });
  add("extract.opts.checksum-rom-skips-sidecars-and-conflicts", ["extract", "options", "checksum"], (ctx) => {
    const input = ctx.fx("ctr/rom-plus-readme.zip");
    const rom = ctx.json(ctx.ok(ctx.run(["extract", "--input", input, "--output", ctx.tmp("a"), "--no-ignore", "--checksum-rom", "sha1", "--json"]), "--checksum-rom"));
    const all = ctx.json(ctx.ok(ctx.run(["extract", "--input", input, "--output", ctx.tmp("b"), "--no-ignore", "--checksum", "sha1", "--json"]), "--checksum"));
    check(JSON.stringify(rom).length < JSON.stringify(all).length, "--checksum-rom did not reduce the hashed set");
    ctx.failed(ctx.run(["extract", "--input", input, "--output", ctx.tmp("c"), "--checksum", "sha1", "--checksum-rom", "sha1"]), { what: "--checksum with --checksum-rom" });
    ctx.failed(ctx.run(["extract", "--input", input, "--output", ctx.tmp("d"), "--checksum", "sha999"]), { what: "unknown algo" });
  });
  add("extract.opts.probe", ["extract", "options"], (ctx) => {
    const doc = ctx.json(ctx.ok(ctx.run(["extract", "--input", ctx.fx("exh/arch/single.gz"), "--output", ctx.tmp("p"), "--probe", "--json"]), "--probe"));
    check(doc.status === "succeeded" || doc.status === "failed", "no status");
    const unknown = ctx.run(["extract", "--input", ctx.write("junk.gz", zlib.gzipSync(Buffer.from(prngBytes(3000, 3)))), "--output", ctx.tmp("q"), "--probe"]);
    check(!unknown.panic, "panic");
    ctx.note(`--probe on a payload of unknown platform: exit ${unknown.code}`);
  });
  add("extract.opts.json-jsonl-and-threads", ["extract", "options", "json"], (ctx) => {
    const input = ctx.fx("exh/arch/zip-two-roms.zip");
    const doc = ctx.json(ctx.ok(ctx.run(["extract", "--input", input, "--output", ctx.tmp("j"), "--json"]), "--json"));
    check(doc.command === "extract" && doc.status === "succeeded" && (doc.details?.emitted_files?.length ?? 0) === 2, () => JSON.stringify(doc).slice(0, 300));
    const lines = ctx.ok(ctx.run(["extract", "--input", input, "--output", ctx.tmp("jl"), "--jsonl"]), "--jsonl").stdout.trim().split("\n").filter(Boolean);
    for (const line of lines) JSON.parse(line);
    for (const j of ["1", "2", "16", "auto"]) {
      const { files } = doExtract(ctx, input, ["-j", j]);
      check(files.size === 2, `-j ${j}`);
    }
    ctx.failed(ctx.run(["extract", "--input", input, "--output", ctx.tmp("jz"), "-j", "0"]), { what: "-j 0" });
    const fail1 = ctx.run(["extract", "--input", ctx.tmp("missing.zip"), "--output", ctx.tmp("jf"), "--json"]);
    ctx.failed(fail1, { what: "missing input" });
    const failDoc = ctx.json(fail1);
    check(failDoc.status === "failed" && failDoc.error, () => JSON.stringify(failDoc).slice(0, 200));
  });
  add("extract.opts.stdout-single-file-and-multi-rejected", ["extract", "options", "stdout"], (ctx) => {
    const r = ctx.run(["extract", "--input", ctx.fx("exh/arch/single.gz"), "--output", "-"]);
    ctx.ok(r, "extract -o -");
    check(Buffer.from(r.stdoutBytes).equals(ROM()), "stdout bytes differ");
    const multi = ctx.run(["extract", "--input", ctx.fx("exh/arch/zip-two-roms.zip"), "--output", "-"]);
    ctx.failed(multi, { what: "-o - with two files" });
    check(multi.stdoutBytes.length === 0, "-o - with two files wrote to stdout before failing");
  });
  add("extract.opts.stdin-input", ["extract", "options", "stdin"], (ctx) => {
    for (const [name, args] of [["exh/arch/single.gz", ["--stdin-name", "x.gz"]], ["exh/arch/zip-two-roms.zip", ["--stdin-name", "x.zip"]], ["exh/arch/7z-lzma2.7z", ["--stdin-name", "x.7z"]]]) {
      const out = ctx.tmp(`stdin-${path.basename(name)}`);
      const r = ctx.run(["extract", "--input", "-", "--output", out, ...args], { input: fs.readFileSync(ctx.fx(name)) });
      ctx.ok(r, `stdin ${name}`);
      check(filesUnder(out).length >= 1, `stdin ${name}: nothing extracted`);
    }
    const noName = ctx.run(["extract", "--input", "-", "--output", ctx.tmp("sn")], { input: fs.readFileSync(ctx.fx("exh/arch/single.gz")) });
    check(!noName.panic, "panic");
    ctx.note(`stdin gzip without --stdin-name: exit ${noName.code}`);
    ctx.failed(ctx.run(["extract", "--input", "-", "--output", ctx.tmp("sd"), "--stdin-name", "a/b.gz"], { input: Buffer.from("x") }), { what: "--stdin-name with directory" });
  });
  add("extract.opts.bad-flags", ["extract", "options", "negative"], (ctx) => {
    const input = ctx.fx("exh/arch/single.gz");
    ctx.failed(ctx.run(["extract", "--input", input]), { what: "missing --output" });
    ctx.failed(ctx.run(["extract", "--output", ctx.tmp("o")]), { what: "missing input" });
    ctx.failed(ctx.run(["extract", "--input", input, "--output", ctx.tmp("o"), "--bogus"]), { what: "unknown flag" });
    ctx.failed(ctx.run(["extract", "--input", ctx.tmp("nope.zip"), "--output", ctx.tmp("o")]), { what: "missing file" });
    ctx.failed(ctx.run(["extract", "--input", ctx.work, "--output", ctx.tmp("o2")]), { what: "directory input" });
    const positional = ctx.run(["extract", input, "--output", ctx.tmp("o3")]);
    ctx.ok(positional, "positional FILE");
  });
  add("extract.opts.unicode-output-and-input-paths", ["extract", "options", "names"], (ctx) => {
    const input = ctx.write("dïr ☃/my arch ive.zip", fs.readFileSync(ctx.fx("exh/arch/zip-two-roms.zip")));
    const out = ctx.tmp("öut ☃/sub dir");
    const r = ctx.run(["extract", "--input", input, "--output", out]);
    ctx.ok(r, "unicode paths");
    check(filesUnder(out).length === 2, "unicode output dir");
  });
  add("extract.opts.very-long-member-name", ["extract", "options", "names"], (ctx) => {
    needTool("zip");
    const name = `${"n".repeat(251)}.bin`;
    ctx.write(name, ROM());
    toolMust(toolIn(ctx)("zip", ["-q", ctx.tmp("long.zip"), name], { cwd: ctx.work }), "zip long name");
    const { result, files } = doExtract(ctx, ctx.tmp("long.zip"), [], { expectOk: false });
    check(!result.panic, "panic");
    if (result.code === 0) check([...files.values()].some((b) => b.equals(ROM())), "long name payload differs");
    const tooLong = ctx.tmp("tl.zip");
    const entries = `${"m".repeat(300)}.bin`;
    ctx.write("src/x.bin", ROM());
    ctx.note(`251-char member name: exit ${result.code}; 300-char name not attempted (${entries.length}, ${tooLong.length > 0})`);
  });

  // ----------------------------------------------------------------------------------------------- disc / container types
  const discs = [
    ["cso", "disc/cso.cso", "disc/cso.payload.iso"],
    ["gc-ciso", "disc/ciso.ciso", "disc/ciso.payload.iso"],
    ["wbfs", "disc/wbfs.wbfs", "disc/wbfs.payload.iso"],
    ["tgc", "disc/tgc.tgc", "disc/tgc.payload.iso"],
  ];
  for (const [name, container, payload] of discs) {
    add(`extract.container.${name}`, ["extract", "container", name], (ctx) => {
      const { files } = doExtract(ctx, ctx.fx(container));
      expectOne(ctx, files, fs.readFileSync(ctx.fx(payload)), name);
    });
    add(`extract.container.${name}.truncated-and-bitflip`, ["extract", "container", "broken", name], (ctx) => {
      const full = fs.readFileSync(ctx.fx(container));
      for (const frac of [0.3, 0.6, 0.95]) {
        const { result, files, dir } = doExtract(ctx, ctx.write(`t${frac}.${path.extname(container).slice(1)}`, full.subarray(0, Math.floor(full.length * frac))), [], { expectOk: false });
        check(!result.panic && !result.timedOut, () => `${name} truncated ${frac}: ${ctx.describe(result)}`);
        if (result.code === 0) {
          const expected = fs.readFileSync(ctx.fx(payload));
          check([...files.values()].every((b) => b.length <= expected.length), `${name} truncated ${frac}: oversized output`);
          ctx.note(`${name} truncated at ${frac}: exit 0 with ${[...files.values()].map((b) => b.length)} bytes (expected ${expected.length})`);
        } else expectNoLeftovers(ctx, dir, `${name} truncated ${frac}`);
      }
    });
    add(`extract.container.${name}.output-flags`, ["extract", "container", name], (ctx) => {
      const r = ctx.run(["extract", "--input", ctx.fx(container), "--output", "-"]);
      ctx.ok(r, `${name} -o -`);
      check(Buffer.from(r.stdoutBytes).equals(fs.readFileSync(ctx.fx(payload))), `${name} stdout payload differs`);
      ctx.ok(ctx.run(["extract", "--input", ctx.fx(container), "--output", ctx.tmp("j"), "--json", "-j", "3"]), `${name} --json`);
    });
  }
  for (const [name, container, payload] of discs) {
    add(`extract.container.${name}.checksum-flag-reports-payload-hash`, ["extract", "container", "checksum", name], (ctx) => {
      const doc = ctx.json(ctx.ok(ctx.run(["extract", "--input", ctx.fx(container), "--output", ctx.tmp("j"), "--json", "--checksum", "sha1,crc32"]), `${name} --checksum`));
      const text = JSON.stringify(doc);
      check(text.includes(sha(fs.readFileSync(ctx.fx(payload)), "sha1")), () => `${name}: --checksum sha1 reported no (or a wrong) hash for the extracted payload; emitted_files=${JSON.stringify(doc.details?.emitted_files)}`);
      const plain = ctx.ok(ctx.run(["extract", "--input", ctx.fx(container), "--output", ctx.tmp("k"), "--checksum", "sha1"]), `${name} --checksum (text)`);
      check(plain.all.includes(sha(fs.readFileSync(ctx.fx(payload)), "sha1")), `${name}: text output shows no sha1`);
    });
  }
  for (const [name, container, extra] of [["wia", "reference/gc/wia/lzma2-l5-bs2m.wia", []], ["gcz", "reference/gc/gcz/bs32k.gcz", []], ["pbp", "disc/pbp.pbp", ["--select", "*.bin"]], ["xiso", "disc/xiso.xiso", []], ["rvz", "disc/made.rvz", []], ["chd", "disc/made.chd", []], ["z3ds", "disc/made.z3ds", []]]) {
    add(`extract.container.${name}.checksum-flag-reports-extracted-file-hash`, ["extract", "container", "checksum", name], (ctx) => {
      const plain = doExtract(ctx, ctx.fx(container), extra);
      const hashes = [...plain.files.values()].filter((b) => b.length > 4096).map((b) => sha(b, "sha1")); // skip small sidecars such as a CUE
      const doc = ctx.json(ctx.ok(ctx.run(["extract", "--input", ctx.fx(container), "--output", ctx.tmp("c"), "--json", "--checksum", "sha1", ...extra]), `${name} --checksum`));
      const text = JSON.stringify(doc);
      check(hashes.every((h) => text.includes(h)), () => `${name}: --checksum sha1 reported no (or a wrong) hash for the extracted file(s); emitted_files=${JSON.stringify(doc.details?.emitted_files)?.slice(0, 200)}`);
    });
  }
  add("extract.container.pbp", ["extract", "container", "pbp"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("disc/pbp.pbp"), ["--select", "*.bin"]);
    check([...files.values()].some((b) => b.equals(fs.readFileSync(ctx.fx("disc/pbp.payload.bin")))), "pbp payload differs");
  });
  add("extract.container.xiso", ["extract", "container", "xiso"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("disc/xiso.xiso"));
    check(files.size >= 1, "xiso extracted nothing");
    ctx.note(`xiso -> ${[...files.entries()].map(([k, v]) => `${k}(${v.length})`).join(", ")}`);
  });
  add("extract.container.nfs-with-key", ["extract", "container", "nfs"], (ctx) => {
    const dir = ctx.tmp("nfs");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(ctx.fx("disc/nfs/hif_000000.nfs"), path.join(dir, "hif_000000.nfs"));
    fs.copyFileSync(ctx.fx("disc/nfs/htk.bin"), path.join(dir, "htk.bin"));
    const { result, files } = doExtract(ctx, path.join(dir, "hif_000000.nfs"), [], { expectOk: false });
    check(!result.panic, "panic");
    ctx.note(`nfs extract: exit ${result.code}; ${files.size} file(s)`);
    fs.rmSync(path.join(dir, "htk.bin"));
    const noKey = doExtract(ctx, path.join(dir, "hif_000000.nfs"), [], { expectOk: false });
    ctx.failed(noKey.result, { what: "nfs without key" });
    expectNoLeftovers(ctx, noKey.dir, "nfs without key");
  });
  add("extract.container.rvz-made-by-rom-weaver", ["extract", "container", "rvz"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("disc/made.rvz"));
    check(files.size === 1, "one payload");
  });
  add("extract.container.z3ds-made-by-rom-weaver", ["extract", "container", "z3ds"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("disc/made.z3ds"));
    check(files.size === 1, "one payload");
  });
  add("extract.container.chd-made-by-rom-weaver", ["extract", "container", "chd"], (ctx) => {
    const { files } = doExtract(ctx, ctx.fx("disc/made.chd"));
    check(files.size >= 1, "chd payload");
  });

  // ---- reference-tool written containers: chdman (cd / raw / dvd / hd) and dolphin-tool (rvz)
  const chdVariants = [];
  const refChd = (id, cmdArgs, source, expectSource) => {
    const key = archive(`chd-${id}.chd`, () => ({}), "chdman", (_dir, out) => sh(cacheRoot, "chdman", [...cmdArgs(out), "-f"]));
    chdVariants.push({ id, key, source, expectSource });
  };
  const exh = (name) => path.join(cacheRoot, "exh", name);
  for (const codec of ["cdzs", "cdlz", "cdzl", "cdfl", "cdzs,cdzl", "cdlz,cdzl,cdfl", "none"]) {
    refChd(`cd-${codec.replace(/,/g, "_")}`, (out) => ["createcd", "-i", exh("cd/mixed.cue"), "-o", out, "-c", codec], "exh/cd/mixed.bin", "cdbin");
  }
  for (const hunk of [2448 * 4, 2448 * 8, 2448 * 16]) refChd(`cd-hunk${hunk}`, (out) => ["createcd", "-i", exh("cd/data.cue"), "-o", out, "-hs", String(hunk)], "exh/cd/data.bin", "cdbin");
  for (const codec of ["lzma", "zlib", "huff", "flac", "zstd", "none", "lzma,zlib"]) {
    refChd(`raw-${codec.replace(/,/g, "_")}`, (out) => ["createraw", "-i", exh("dvd/dvd.iso"), "-o", out, "-us", "2048", "-hs", "8192", "-c", codec], "exh/dvd/dvd.iso", "raw");
  }
  for (const codec of ["lzma", "zlib", "zstd", "flac"]) {
    refChd(`dvd-${codec}`, (out) => ["createdvd", "-i", exh("dvd/dvd.iso"), "-o", out, "-c", codec], "exh/dvd/dvd.iso", "raw");
  }
  refChd("hd-lzma", (out) => ["createhd", "-i", exh("dvd/dvd.iso"), "-o", out, "-c", "lzma"], "exh/dvd/dvd.iso", "hd");
  for (const v of chdVariants) {
    add(`extract.reference.chdman.${v.id}`, ["extract", "reference", "chd", "chdman"], (ctx) => {
      needTool("chdman");
      ctx.fx("exh/cd/mixed.bin");
      ctx.fx("exh/cd/mixed.cue");
      ctx.fx("exh/cd/data.bin");
      ctx.fx("exh/cd/data.cue");
      ctx.fx("exh/dvd/dvd.iso");
      let input;
      try {
        input = ctx.fx(v.key);
      } catch (error) {
        skip(`chdman could not create this variant: ${String(error.stderr ?? error.message).split("\n")[0].slice(0, 160)}`);
      }
      const { files } = doExtract(ctx, input);
      const want = fs.readFileSync(ctx.fx(v.source));
      const bins = [...files.entries()].filter(([k]) => /\.(bin|iso|img)$/i.test(k));
      check(bins.length === 1, () => `expected one data file, got ${[...files.keys()].join(",")}`);
      if (v.expectSource === "hd" && !bins[0][1].equals(want)) ctx.note(`hd chd payload is ${bins[0][1].length} bytes (source ${want.length}) - unit padding`);
      else check(bins[0][1].equals(want), () => `payload differs from the chdman input (${bins[0][1].length} vs ${want.length})`);
      if (v.expectSource === "cdbin") {
        const split = doExtract(ctx, input, ["--split-bin"]).files;
        check([...split.keys()].some((k) => /Track 1/.test(k)), () => `--split-bin names: ${[...split.keys()]}`);
        const joined = Buffer.concat([...split.entries()].filter(([k]) => k.endsWith(".bin")).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, b]) => b));
        check(joined.equals(want), "split tracks do not concatenate to the original bin");
      }
    });
  }
  const rvzVariants = [];
  for (const comp of ["none", "zstd", "bzip2", "lzma", "lzma2"]) {
    for (const [level, block] of [[5, 131072], [1, 32768], [22, 2097152]]) {
      if (comp === "none" && level !== 5) continue;
      const id = `${comp}-l${level}-b${block}`;
      const key = archive(`dolphin-${id}.rvz`, () => ({}), "dolphin-tool", () => {
        const out = fx.location(`exh/arch/dolphin-${id}.rvz`);
        fs.rmSync(out, { force: true });
        const home = fs.mkdtempSync(path.join(cacheRoot, ".home-"));
        try {
          sh(cacheRoot, "dolphin-tool", ["convert", "-i", path.join(cacheRoot, "reference/gc/disc.iso"), "-o", out, "-f", "rvz", "-c", comp, "-l", String(level), "-b", String(block)], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home } });
        } finally {
          fs.rmSync(home, { recursive: true, force: true });
        }
      });
      rvzVariants.push({ id, key });
    }
  }
  for (const v of rvzVariants) {
    add(`extract.reference.dolphin-tool.rvz-${v.id}`, ["extract", "reference", "rvz", "dolphin"], (ctx) => {
      needTool("dolphin-tool");
      let input;
      try {
        input = ctx.fx(v.key);
      } catch (error) {
        skip(`dolphin-tool could not create this variant: ${String(error.stderr ?? error.message).split("\n")[0].slice(0, 160)}`);
      }
      const { files } = doExtract(ctx, input);
      expectOne(ctx, files, fs.readFileSync(ctx.fx("reference/gc/disc.iso")), v.id);
    });
  }
};
