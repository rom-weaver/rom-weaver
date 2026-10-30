// Input containers for the source ROM and for patches (archives, stream codecs, disc images).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { add, check, skip } from "../lib/harness.mjs";
import { have } from "../lib/fixture-defs.mjs";
import * as E from "../lib/encoders.mjs";

const IPS = "patches/ind/same.ips";

/** Apply `patch` to a container-wrapped ROM and compare with the expected raw target. */
const viaContainer = (ctx, input, { patch = IPS, expect = "rom/same.bin", extra = [], out = "out.bin" } = {}) => {
  const output = ctx.tmp(out);
  const result = ctx.apply(ctx.fx(input), ctx.fx(patch), output, extra);
  return { result, output, expected: ctx.fx(expect) };
};
const needTool = (tool) => {
  // quality-reason: the case authors its archive with the named host tool, so it cannot run without it; the extractor itself is covered by Rust tests in crates/rom-weaver-containers.
  for (const name of [tool].flat()) if (!have(name)) skip(`${name} not installed on this host`);
};

export const register = async ({ root, fixtures }) => {
  // ----------------------------------------------------- source ROM in archives / streams
  const archives = [
    ["zip-deflate", "zip-deflate.zip", "zip"],
    ["zip-store", "zip-store.zip", "zip"],
    ["zip-bsdtar", "bsdtar.zip", "bsdtar"],
    ["zip-rom-weaver", "rw.zip", null],
    ["zip-rom-weaver-store", "rw-store.zip", null],
    ["zip-rom-weaver-zstd", "rw-zstd.zip", null],
    ["7z-rom-weaver", "rw.7z", null],
    ["7z-bsdtar", "bsdtar.7z", "bsdtar"],
    ["tar", "plain.tar", "tar"],
    ["tar.gz", "plain.tar.gz", "tar"],
    ["tgz", "plain.tgz", "tar"],
    ["tar.bz2", "plain.tar.bz2", ["tar", "bzip2"]],
    ["tbz2", "plain.tbz2", ["tar", "bzip2"]],
    ["tar.xz", "plain.tar.xz", ["tar", "xz"]],
    ["txz", "plain.txz", ["tar", "xz"]],
    ["gz", "game.bin.gz", "gzip"],
    ["bz2", "game.bin.bz2", "bzip2"],
    ["xz", "game.bin.xz", "xz"],
    ["zst", "game.bin.zst", "zstd"],
    ["nested-zip-in-zip", "nested-outer.zip", "zip"],
    ["nested-7z-in-tgz", "nested-tgz-7z.tgz", ["bsdtar", "tar"]],
    ["subdir-unicode-names", "subdir.zip", "zip"],
    ["rom-plus-readme", "rom-plus-readme.zip", "zip"],
  ];
  for (const [name, file, tool] of archives) {
    add(`container.source.${name}`, ["container", "source", name], (ctx) => {
      if (tool) needTool(tool);
      const { result, output, expected } = viaContainer(ctx, `ctr/${file}`);
      ctx.ok(result, `apply from ${file}`);
      ctx.same(output, expected, "patched output");
    });
    add(`container.source.${name}.determinism`, ["container", "determinism", name], (ctx) => {
      if (tool) needTool(tool);
      const a = viaContainer(ctx, `ctr/${file}`, { extra: ["-j", "1"], out: "a.bin" });
      const b = viaContainer(ctx, `ctr/${file}`, { extra: ["-j", "8"], out: "b.bin" });
      ctx.ok(a.result, "-j1");
      ctx.ok(b.result, "-j8");
      ctx.same(b.output, a.output, "-j8 vs -j1");
    });
  }
  add("container.source.7z-split-volume", ["container", "7z", "negative"], (ctx) => {
    needTool("7z");
    const input = ctx.write("game.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
    const archive = ctx.tmp("split.7z");
    const made = spawnSync("7z", ["a", "-t7z", "-mx=0", "-v16k", archive, input], { encoding: "utf8" });
    check(made.status === 0, `7z split fixture: ${made.stderr}`);
    for (const suffix of ["001", "002"]) {
      const volume = `${archive}.${suffix}`;
      const original = fs.readFileSync(volume);
      const target = Buffer.from(original);
      target[100] ^= 0xff;
      const patch = ctx.write(`volume-${suffix}.bps`, E.encodeBps(original, target));
      ctx.failed(ctx.run(["extract", "-i", volume, "-o", ctx.tmp(`extract-${suffix}`)]), { what: "extract split 7z" });
      const out = ctx.tmp(`out-${suffix}.bin`);
      ctx.failed(ctx.apply(volume, patch, out), { message: /7z|volume/i, what: "apply split 7z" });
      check(!ctx.exists(out), "split 7z apply left an output");
      check(fs.readFileSync(volume).equals(original), "split 7z apply changed its input");
    }
  });
  add("reference.7z.source.deflate64-codec", ["reference", "7z", "deflate64"], (ctx) => {
    needTool("7z");
    const input = ctx.write("game.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
    const archive = ctx.tmp("deflate64.7z");
    const made = spawnSync("7z", ["a", "-t7z", "-m0=Deflate64", archive, input], { encoding: "utf8" });
    check(made.status === 0, `7z Deflate64 fixture: ${made.stderr}`);
    const extracted = ctx.tmp("extracted");
    ctx.ok(ctx.run(["extract", "-i", archive, "-o", extracted]), "extract Deflate64 7z");
    ctx.same(path.join(extracted, "game.bin"), input, "extracted Deflate64 payload");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(archive, ctx.fx(IPS), out), "apply Deflate64 7z");
    ctx.same(out, ctx.fx("rom/same.bin"), "Deflate64 patched output");
  });
  add("container.source.lzma-alone-unregistered", ["container", "negative"], (ctx) => {
    needTool("lzma");
    const { result, output } = viaContainer(ctx, "ctr/game.bin.lzma");
    // `.lzma` (lzma-alone) is not a registered container: the file is treated as a raw ROM, so the patched bytes must not match.
    check(!result.panic, () => ctx.describe(result));
    if (result.code === 0) check(!fs.readFileSync(output).equals(fs.readFileSync(ctx.fx("rom/same.bin"))), "lzma-alone silently decoded although unregistered");
  });
  add("container.source.rar5-stored", ["container", "source", "rar"], (ctx) => {
    const rar = "ext:tests/fixtures/rar/rar5-stored.rar";
    const probe = ctx.run(["extract", "--input", ctx.fx(rar), "--output", ctx.tmp("ex")]);
    ctx.ok(probe, "extract rar5-stored");
    const payload = fs.readFileSync(path.join(ctx.tmp("ex"), fs.readdirSync(ctx.tmp("ex")).find((f) => !/empty/.test(f))));
    const target = Buffer.from(payload);
    target[3] ^= 0xff;
    const patch = ctx.write("p.ips", E.encodeIps(payload, target));
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx(rar), patch, out, ["--select", "payload"]), "apply from rar");
    check(fs.readFileSync(out).equals(target), "rar-sourced output mismatch");
  });
  const extractOnly = [["lz4", "payload.txt.lz4"], ["zipx", "payload.zipx"], ["tar-fixture", "payload.tar"], ["gz-fixture", "payload.txt.gz"], ["bz2-fixture", "payload.txt.bz2"], ["xz-fixture", "payload.txt.xz"], ["zst-fixture", "payload.txt.zst"], ["tar.gz-fixture", "payload.tar.gz"], ["tar.bz2-fixture", "payload.tar.bz2"], ["tar.xz-fixture", "payload.tar.xz"]];
  for (const [name, file] of extractOnly) {
    add(`container.source.existing-${name}`, ["container", "source", name], (ctx) => {
      const input = ctx.fx(`ext:tests/fixtures/extract-only/${file}`);
      const payload = fs.readFileSync(ctx.fx("ext:tests/fixtures/extract-only/payload.txt"));
      const target = Buffer.from(payload);
      target[10] ^= 0xff;
      const patch = ctx.write("p.ips", E.encodeIps(payload, target));
      const out = ctx.tmp("out.txt");
      const result = ctx.apply(input, patch, out, ["--no-ignore"]); // payload.txt is not a ROM extension
      ctx.ok(result, `apply from ${file}`);
      check(fs.readFileSync(out).equals(target), "output mismatch");
    });
  }

  // ----------------------------------------------------------- selection / ambiguity
  add("container.select.multi-rom-without-select-fails", ["container", "select", "negative"], (ctx) => {
    const { result, output } = viaContainer(ctx, "ctr/two-roms.zip");
    ctx.failed(result, { message: /ambiguous|select|candidates/i, what: "multi-ROM archive without --select" });
    check(!ctx.exists(output), "ambiguous apply left an output");
  });
  for (const [label, pattern] of [["exact", "game.bin"], ["glob", "game*"], ["glob-other", "other.bin"]]) {
    add(`container.select.${label}`, ["container", "select"], (ctx) => {
      const { result, output } = viaContainer(ctx, "ctr/two-roms.zip", { extra: ["--select", pattern] });
      if (label === "glob-other") {
        // other.bin is wrong.bin (base with one byte flipped): IPS still applies, so the output must differ from same.bin.
        ctx.ok(result, "--select other.bin");
        check(!fs.readFileSync(output).equals(fs.readFileSync(ctx.fx("rom/same.bin"))), "selected the wrong member");
        return;
      }
      ctx.ok(result, `--select ${pattern}`);
      ctx.same(output, ctx.fx("rom/same.bin"), "selected member output");
    });
  }
  add("container.select.directory-prefix", ["container", "select"], (ctx) => {
    const { result, output } = viaContainer(ctx, "ctr/subdir.zip", { extra: ["--select", "dir one"] });
    ctx.ok(result, "--select <directory prefix>");
    ctx.same(output, ctx.fx("rom/same.bin"), "output");
  });
  add("container.select.name-stem-is-not-a-prefix", ["container", "select", "negative"], (ctx) => {
    // `--select` prefixes are path-segment prefixes ("dir" matches "dir/x.bin"), not filename stems.
    const { result } = viaContainer(ctx, "ctr/two-roms.zip", { extra: ["--select", "game"] });
    ctx.failed(result, { message: /not found|no match|select/i, what: "--select with a bare filename stem" });
  });
  add("container.select.no-match-fails", ["container", "select", "negative"], (ctx) => {
    const { result, output } = viaContainer(ctx, "ctr/two-roms.zip", { extra: ["--select", "nope*"] });
    ctx.failed(result, { what: "--select with no match" });
    check(!ctx.exists(output), "no-match select left an output");
  });
  add("container.select.filter-rom-only", ["container", "select"], (ctx) => {
    const { result, output } = viaContainer(ctx, "ctr/rom-plus-readme.zip", { extra: ["--filter", "rom"] });
    ctx.ok(result, "--filter rom");
    ctx.same(output, ctx.fx("rom/same.bin"), "output");
  });
  add("container.select.no-ignore-exposes-readme", ["container", "select"], (ctx) => {
    const { result } = viaContainer(ctx, "ctr/rom-plus-readme.zip", { extra: ["--no-ignore"] });
    check(!result.panic, () => ctx.describe(result));
    // With ignores disabled the readme/nfo become candidates, so a non-interactive run is ambiguous (or still resolves by extension).
    check(result.code === 0 || /ambiguous|select|candidates/i.test(result.all), () => `unexpected failure: ${ctx.describe(result)}`);
  });
  add("container.retroarch.patch-found-in-archive", ["container", "select"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.run(["patch", "apply", "--input", ctx.fx("ctr/rom-plus-patch.zip"), "--output", out, "--no-compress"]);
    ctx.ok(result, "apply without --patch (RetroArch layout)");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });
  add("container.no-extract.treats-archive-as-raw", ["container", "select"], (ctx) => {
    const zipBytes = fs.readFileSync(ctx.fx("ctr/zip-store.zip"));
    const target = Buffer.from(zipBytes);
    target[100] ^= 0xff;
    const patch = ctx.write("raw.ips", E.encodeIps(zipBytes, target));
    const out = ctx.tmp("out.zip");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx("ctr/zip-store.zip"), "--patch", patch, "--output", out, "--no-compress", "--no-extract"]), "--no-extract");
    check(fs.readFileSync(out).equals(target), "--no-extract did not patch the raw container bytes");
  });

  // ------------------------------------------------------------------ broken archives
  for (const [label, fixture, tool] of [["truncated-zip", "truncated.zip", "zip"], ["truncated-7z", "truncated.7z", null], ["truncated-tar.gz", "truncated.tar.gz", "tar"], ["garbage-zip", "garbage.zip", null], ["garbage-7z", "garbage.7z", null], ["empty-zip", "empty.zip", "zip"], ["encrypted-zip", "encrypted.zip", "zip"]]) {
    add(`container.broken.${label}`, ["container", "negative", label], (ctx) => {
      if (tool) needTool(tool);
      const { result, output } = viaContainer(ctx, `ctr/${fixture}`);
      ctx.failed(result, { what: label });
      check(!ctx.exists(output), `${label} left an output file`);
      check(result.all.trim().length > 0, "failure printed no message");
    });
  }
  add("container.broken.encrypted-zip-message-mentions-encryption", ["container", "negative"], (ctx) => {
    needTool("zip");
    const { result } = viaContainer(ctx, "ctr/encrypted.zip");
    ctx.failed(result, { message: /encrypt|password|passphrase/i, what: "encrypted zip" });
  });
  add("container.broken.readme-only-zip", ["container", "negative"], (ctx) => {
    const { result, output } = viaContainer(ctx, "ext:packages/rom-weaver-webapp/tests/fixtures/archives/readme-only.zip");
    ctx.failed(result, { what: "archive with no ROM" });
    check(!ctx.exists(output), "left an output");
  });

  add("container.safety.zip-slip-member-name", ["container", "negative", "safety"], (ctx) => {
    // quality-reason: python3 is the only writer of a ../ member name here (system zip refuses to); path-traversal rejection is also covered by Rust tests in crates/rom-weaver-containers/tests/unit/archive_entries.rs.
    if (!have("python3")) skip("python3 not installed (used only to write a ../ member name)");
    const zip = ctx.tmp("slip.zip");
    const script = "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../../escaped.bin', open(sys.argv[2],'rb').read()); z.close()";
    const made = spawnSync("python3", ["-I", "-c", script, zip, ctx.fx("rom/base.bin")]);
    check(made.status === 0, "could not write slip.zip");
    const out = ctx.tmp("deep/out.bin");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const result = ctx.apply(zip, ctx.fx(IPS), out);
    check(!result.panic, () => ctx.describe(result));
    for (const escaped of [path.join(ctx.work, "escaped.bin"), path.join(path.dirname(ctx.work), "escaped.bin"), path.join(path.dirname(path.dirname(ctx.work)), "escaped.bin")]) check(!ctx.exists(escaped), `member name escaped the extraction directory: ${escaped}`);
  });
  add("container.safety.tar-symlink-member", ["container", "negative", "safety"], (ctx) => {
    needTool("tar");
    const dir = ctx.tmp("tarsrc");
    fs.mkdirSync(dir);
    fs.symlinkSync("/etc/passwd", path.join(dir, "game.bin"));
    const tarball = ctx.tmp("link.tar");
    const made = spawnSync("tar", ["cf", tarball, "-C", dir, "game.bin"]);
    check(made.status === 0, "could not write link.tar");
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(tarball, ctx.fx(IPS), out);
    check(!result.panic, () => ctx.describe(result));
    if (result.code === 0) check(!fs.readFileSync(out).includes("root:"), "symlink member was followed out of the archive");
  });

  // ------------------------------------------------------------ patch containers
  const patchContainers = [
    ["zip", "patch.bps.zip", "zip"], ["7z", "patch.bps.7z", "bsdtar"], ["tar.gz", "patch.bps.tar.gz", "tar"], ["gz", "patch.bps.gz", "gzip"],
    ["xz", "patch.bps.xz", "xz"], ["zst", "patch.bps.zst", "zstd"], ["bz2", "patch.bps.bz2", "bzip2"],
  ];
  for (const [name, file, tool] of patchContainers) {
    add(`container.patch.${name}`, ["container", "patch", name], (ctx) => {
      needTool(tool);
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx(`ctr/${file}`), out), `patch from ${file}`);
      ctx.same(out, ctx.fx("rom/same.bin"), "output");
    });
  }
  add("container.patch.multi-patch-archive-needs-selection", ["container", "patch", "select"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("ctr/patches-multi.zip"), out);
    // Either every patch in the archive is applied in order (base->same by bps, then ips on top) or the run refuses as ambiguous.
    check(!result.panic, () => ctx.describe(result));
    if (result.code !== 0) check(/ambiguous|select|candidate/i.test(result.all), () => ctx.describe(result));
  });
  add("container.patch.multi-patch-archive-patch-select", ["container", "patch", "select"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("ctr/patches-multi.zip"), out, ["--patch-select", "same.bps"]), "--patch-select");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });
  add("container.patch.multi-patch-archive-select-fallback", ["container", "patch", "select"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("ctr/patches-multi.zip"), out, ["--select", "*.bps"]), "--select *.bps");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });
  add("container.patch.encrypted-zip", ["container", "patch", "negative"], (ctx) => {
    needTool("zip");
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("ctr/patch-encrypted.zip"), out), { what: "encrypted patch archive" });
    check(!ctx.exists(out), "left an output");
  });
  add("container.patch.no-extract-treats-zip-as-patch-bytes", ["container", "patch", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("ctr/patch.bps.zip"), out, ["--no-extract"]);
    ctx.failed(result, { what: "zip as raw patch" });
  });
  add("container.both.rom-and-patch-in-archives", ["container", "patch"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("ctr/rw.7z"), ctx.fx("ctr/patch.bps.zip"), out), "7z ROM + zip patch");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });

  // ---------------------------------------------------------------- disc containers
  let discs;
  try {
    const fixturesDir = path.join(root, "packages/rom-weaver-webapp/tests/fixtures");
    const mod = await import(pathToFileURL(path.join(fixturesDir, "synthetic-patch-containers.mjs")).href);
    const nfs = await import(pathToFileURL(path.join(fixturesDir, "synthetic-nfs.mjs")).href);
    discs = { mod, nfs };
  } catch (error) {
    // quality-reason: importing the webapp disc fixture builders fails only when that package is not installed; the disc containers are then covered by the Rust crates/rom-weaver-containers tests.
    add("container.disc.fixture-builders-unavailable", ["container", "disc"], () => skip(`webapp fixture builders could not be imported: ${error.message}`));
    return;
  }
  const items = discs.mod.patchContainerFixtures();
  const byExt = new Map(items.map((item) => [item.extension, item]));
  const defineDisc = (key, container, payload, ext, payloadExt) => {
    fixtures.define(`disc/${key}.${ext}`, { where: "cache", purpose: `${key} container from the webapp synthetic builders`, how: "packages/rom-weaver-webapp/tests/fixtures/synthetic-patch-containers.mjs", deterministic: true, build: () => container });
    fixtures.define(`disc/${key}.payload.${payloadExt}`, { where: "cache", purpose: `${key} payload`, how: "same builder", deterministic: true, build: () => payload });
    const target = Uint8Array.from(payload);
    target[0x2000] ^= 0xff;
    target[0x2001] ^= 0x12;
    fixtures.define(`disc/${key}.target.${payloadExt}`, { where: "cache", purpose: `${key} patched payload`, how: "payload with two bytes edited", deterministic: true, build: () => target });
    fixtures.define(`disc/${key}.ips`, { where: "cache", purpose: `${key} IPS`, how: "encodeIps(payload, target)", deterministic: true, build: () => E.encodeIps(payload, target) });
  };
  for (const item of items) defineDisc(item.extension, item.container, item.payload, item.extension, item.payloadExtension);
  // split WBFS: same disc cut into two parts (.wbfs + .wbf1)
  const wbfs = byExt.get("wbfs");
  const half = wbfs.container.length >> 1;
  fixtures.define("disc/split/disc.wbfs", { where: "cache", purpose: "first half of a split WBFS", how: "slice", deterministic: true, build: () => wbfs.container.subarray(0, half) });
  fixtures.define("disc/split/disc.wbf1", { where: "cache", purpose: "second half of a split WBFS", how: "slice", deterministic: true, build: () => wbfs.container.subarray(half) });
  fixtures.define("disc/split-missing/disc.wbfs", { where: "cache", purpose: "first part only (missing .wbf1)", how: "slice", deterministic: true, build: () => wbfs.container.subarray(0, half) });
  // XISO
  const xiso = discs.mod.xisoFixture();
  fixtures.define("disc/xiso.xiso", { where: "cache", purpose: "synthetic XDVDFS image", how: "synthetic-patch-containers.mjs xisoFixture", deterministic: true, build: () => xiso });
  // NFS
  const nfsFiles = await discs.nfs.syntheticNfs();
  const nfsBytes = new Uint8Array(await nfsFiles.source.arrayBuffer());
  const nfsKey = new Uint8Array(await nfsFiles.key.arrayBuffer());
  fixtures.define("disc/nfs/hif_000000.nfs", { where: "cache", purpose: "synthetic encrypted NFS", how: "synthetic-nfs.mjs", deterministic: true, build: () => nfsBytes });
  fixtures.define("disc/nfs/htk.bin", { where: "cache", purpose: "NFS key", how: "synthetic-nfs.mjs", deterministic: true, build: () => nfsKey });

  for (const [key, selectArgs] of [["cso", []], ["ciso", []], ["wbfs", []], ["tgc", []], ["pbp", ["--select", "*.bin"]]]) {
    const item = byExt.get(key);
    add(`container.disc.${key}`, ["container", "disc", key], (ctx) => {
      const out = ctx.tmp(`out.${item.payloadExtension}`);
      const result = ctx.apply(ctx.fx(`disc/${key}.${key}`), ctx.fx(`disc/${key}.ips`), out, selectArgs);
      ctx.ok(result, `apply to ${key}`);
      ctx.same(out, ctx.fx(`disc/${key}.target.${item.payloadExtension}`), "patched disc payload");
    });
    add(`container.disc.${key}.determinism`, ["container", "disc", "determinism", key], (ctx) => {
      const a = ctx.tmp(`a.${item.payloadExtension}`);
      const b = ctx.tmp(`b.${item.payloadExtension}`);
      ctx.ok(ctx.apply(ctx.fx(`disc/${key}.${key}`), ctx.fx(`disc/${key}.ips`), a, [...selectArgs, "-j", "1"]), "-j1");
      ctx.ok(ctx.apply(ctx.fx(`disc/${key}.${key}`), ctx.fx(`disc/${key}.ips`), b, [...selectArgs, "-j", "8"]), "-j8");
      ctx.same(b, a, "-j8 vs -j1");
    });
  }
  add("container.disc.pbp.ambiguous-without-select", ["container", "disc", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.apply(ctx.fx("disc/pbp.pbp"), ctx.fx("disc/pbp.ips"), out), { message: /select|ambiguous/i, what: "PBP without --select" });
  });
  add("container.disc.wbfs-split", ["container", "disc", "wbfs"], (ctx) => {
    for (const part of ["disc.wbfs", "disc.wbf1"]) ctx.write(part, fs.readFileSync(ctx.fx(`disc/split/${part}`)));
    const out = ctx.tmp("out.iso");
    ctx.ok(ctx.apply(ctx.tmp("disc.wbfs"), ctx.fx("disc/wbfs.ips"), out), "split wbfs apply");
    ctx.same(out, ctx.fx("disc/wbfs.target.iso"), "split wbfs output");
  });
  add("container.disc.wbfs-split-missing-part", ["container", "disc", "wbfs", "negative"], (ctx) => {
    ctx.write("disc.wbfs", fs.readFileSync(ctx.fx("disc/split-missing/disc.wbfs")));
    const out = ctx.tmp("out.iso");
    ctx.failed(ctx.apply(ctx.tmp("disc.wbfs"), ctx.fx("disc/wbfs.ips"), out), { what: "split WBFS missing .wbf1" });
    check(!ctx.exists(out), "left an output");
  });
  add("container.disc.xiso-patches-raw-image", ["container", "disc", "xiso"], (ctx) => {
    // Unlike `extract` (which rebuilds a normalized ISO), patch apply leaves an .xiso input byte-exact.
    const raw = fs.readFileSync(ctx.fx("disc/xiso.xiso"));
    const target = Buffer.from(raw);
    target[0] ^= 0xff;
    target[100] ^= 0x01;
    const patch = ctx.write("x.ips", E.encodeIps(raw, target));
    const out = ctx.tmp("out.iso");
    ctx.ok(ctx.apply(ctx.fx("disc/xiso.xiso"), patch, out), "apply to xiso");
    check(fs.readFileSync(out).equals(target), "xiso output mismatch");
  });
  add("container.disc.nfs", ["container", "disc", "nfs"], (ctx) => {
    for (const name of ["hif_000000.nfs", "htk.bin"]) ctx.write(name, fs.readFileSync(ctx.fx(`disc/nfs/${name}`)));
    const ex = ctx.tmp("ex");
    ctx.ok(ctx.run(["extract", "--input", ctx.tmp("hif_000000.nfs"), "--output", ex]), "extract nfs");
    const bytes = fs.readFileSync(path.join(ex, fs.readdirSync(ex)[0]));
    const target = Buffer.from(bytes);
    target[0x2000] ^= 0xff;
    const patch = ctx.write("n.ips", E.encodeIps(bytes, target));
    const out = ctx.tmp("out.iso");
    ctx.ok(ctx.apply(ctx.tmp("hif_000000.nfs"), patch, out), "apply to nfs");
    check(fs.readFileSync(out).equals(target), "nfs output mismatch");
  });
  // quality-reason: rom-weaver has no WIA/GCZ writer and this harness does not drive dolphin-tool; read paths are covered by Rust tests rvz_z3ds.rs / shared.rs write_wia_fixture_from_iso.
  add("container.disc.wia-gcz", ["container", "disc", "wia", "gcz"], () => skip("no WIA/GCZ writer in this harness; read paths covered by Rust tests rvz_z3ds.rs / shared.rs write_wia_fixture_from_iso"));

  // RVZ / CHD / Z3DS inputs made by rom-weaver compress from the wbfs payload
  const wbfsPayload = "disc/wbfs.payload.iso";
  for (const [key, ext, args] of [["rvz", "rvz", []], ["chd", "chd", []], ["z3ds", "z3ds", []]]) {
    fixtures.define(`disc/made.${ext}`, {
      where: "cache", purpose: `${key} made by rom-weaver compress from the wbfs payload`, how: `rom-weaver compress --output made.${ext}`, deterministic: false,
      build: (self) => {
        const out = self.location(`disc/made.${ext}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const result = self.run(["compress", "--input", self.path(wbfsPayload), "--output", out, "--force", ...args]);
        if (result.code !== 0) throw new Error(`compress to ${ext} failed: ${result.all.slice(0, 300)}`);
        return undefined;
      },
    });
    add(`container.disc.${key}-input`, ["container", "disc", key], (ctx) => {
      const out = ctx.tmp("out.iso");
      const result = ctx.apply(ctx.fx(`disc/made.${ext}`), ctx.fx("disc/wbfs.ips"), out, key === "chd" ? ["--select", "*.bin"] : []);
      ctx.ok(result, `apply to ${key}`);
      ctx.same(out, ctx.fx("disc/wbfs.target.iso"), `${key} patched payload`);
    });
  }
  add("container.disc.existing-game-rvz", ["container", "disc", "rvz"], (ctx) => {
    const input = ctx.fx("ext:packages/rom-weaver-webapp/tests/fixtures/browser-generated/game.rvz");
    ctx.ok(ctx.run(["extract", "--input", input, "--output", ctx.tmp("ex")]), "extract game.rvz");
    const bytes = fs.readFileSync(path.join(ctx.tmp("ex"), fs.readdirSync(ctx.tmp("ex"))[0]));
    const target = Buffer.from(bytes);
    target[0x3000] ^= 0xff;
    const patch = ctx.write("r.ips", E.encodeIps(bytes, target));
    const out = ctx.tmp("out.iso");
    ctx.ok(ctx.apply(input, patch, out), "apply to game.rvz");
    check(fs.readFileSync(out).equals(target), "rvz output mismatch");
  });
  for (const file of ["game-cd.chd", "raw32.chd"]) {
    add(`container.disc.existing-${file}`, ["container", "disc", "chd"], (ctx) => {
      const input = ctx.fx(`ext:packages/rom-weaver-webapp/tests/fixtures/browser-generated/${file}`);
      const ex = ctx.tmp("ex");
      ctx.ok(ctx.run(["extract", "--input", input, "--output", ex]), `extract ${file}`);
      const candidates = fs.readdirSync(ex).filter((name) => !/\.cue$/i.test(name));
      check(candidates.length > 0, "extract produced no payload");
      const bytes = fs.readFileSync(path.join(ex, candidates[0]));
      const target = Buffer.from(bytes);
      target[100] ^= 0xff;
      const patch = ctx.write("c.ips", E.encodeIps(bytes, target));
      const out = ctx.tmp(`out${path.extname(candidates[0]) || ".bin"}`);
      const hasSheet = fs.readdirSync(ex).some((name) => /\.(cue|gdi)$/i.test(name));
      const result = ctx.apply(input, patch, out, hasSheet ? ["--select", candidates[0]] : []);
      ctx.ok(result, `apply to ${file}`);
      check(fs.readFileSync(out).equals(target), "chd output mismatch");
    });
  }
};
