// Archive parity against 7z / rar / unrar: source ROMs packed by the reference archivers must be readable by
// rom-weaver, and zip/7z results written by rom-weaver must be readable by 7z.
import fs from "node:fs";
import path from "node:path";
import { add, check, skip } from "../lib/harness.mjs";
import { describeTool, filesUnder, needTool, prngBytes, toolIn, toolMust, toolOrSkip } from "../lib/reference-tools.mjs";

const PATCH = "patches/ind/same.ips";
const README = Buffer.from("reference archive companion file\n".repeat(40));

/** Stage `game.bin` (and optionally readme.txt) in a scratch dir for the archiver to pack. */
const stage = (ctx, { readme = false } = {}) => {
  const dir = ctx.tmp("stage");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "game.bin"), ctx.bytes("rom/base.bin"));
  if (readme) fs.writeFileSync(path.join(dir, "readme.txt"), README);
  return dir;
};

/** Apply the IPS patch to a ROM inside `archive` and compare with the raw target. */
const applyFromArchive = (ctx, archive, what) => {
  const out = ctx.tmp("out.bin");
  ctx.ok(ctx.apply(archive, ctx.fx(PATCH), out), `apply from ${what}`);
  ctx.same(out, ctx.fx("rom/same.bin"), `${what}: patched output`);
};
const extractsGameBin = (ctx, archive, what) => {
  const dir = ctx.tmp("ex");
  ctx.ok(ctx.run(["extract", "--input", archive, "--output", dir]), `extract ${what}`);
  const game = filesUnder(dir).find((file) => path.basename(file) === "game.bin");
  check(game, () => `${what}: extract produced no game.bin (have ${filesUnder(dir).map((file) => path.relative(dir, file)).join(",") || "nothing"})`);
  check(fs.readFileSync(game).equals(ctx.bytes("rom/base.bin")), `${what}: extracted game.bin differs from the packed ROM`);
};
/** `rawFallback`: the format is not a registered container, so apply may treat the file as a raw ROM (see container.source.lzma-alone-unregistered). */
const cleanFailure = (ctx, archive, message, what, { rawFallback = false } = {}) => {
  const out = ctx.tmp("out.bin");
  const dir = ctx.tmp("ex-fail");
  ctx.failed(ctx.run(["extract", "--input", archive, "--output", dir]), { message, what: `extract ${what}` });
  check(filesUnder(dir).length === 0, `${what}: failed extract left output files`);
  const applied = ctx.apply(archive, ctx.fx(PATCH), out);
  if (rawFallback && applied.code === 0) {
    ctx.note(`${what}: extract fails but apply exits 0 and patches the file as an unrecognised raw ROM (${fs.statSync(out).size} bytes)`);
    return;
  }
  ctx.failed(applied, { message, what: `apply from ${what}` });
  check(!ctx.exists(out), `${what}: failed apply left an output`);
};

export const register = () => {
  // =============================================================== 7z / zip made by 7z
  const sevenZip = [
    ["copy", ["-m0=Copy"]],
    ["lzma", ["-m0=LZMA"]],
    ["lzma2", ["-m0=LZMA2"]],
    ["ppmd", ["-m0=PPMd"]],
    ["bzip2", ["-m0=BZip2"]],
    ["deflate", ["-m0=Deflate"]],
    ["mx0", ["-mx=0"]],
    ["mx1", ["-mx=1"]],
    ["mx5", ["-mx=5"]],
    ["mx9", ["-mx=9"]],
    ["lzma-dict-64k", ["-m0=LZMA:d=64k"]],
    ["bcj-filter", ["-m0=BCJ", "-m1=LZMA"]],
    ["delta-filter", ["-m0=Delta:4", "-m1=LZMA2"]],
    ["header-uncompressed", ["-mhc=off"]],
    ["no-timestamps", ["-mtm=off", "-mtc=off", "-mta=off"]],
    ["single-thread", ["-mmt=off"]],
    ["solid", ["-ms=on"], { readme: true }],
    ["non-solid", ["-ms=off"], { readme: true }],
    ["solid-two-files-ppmd", ["-ms=on", "-m0=PPMd"], { readme: true }],
  ];
  for (const [name, flags, options = {}] of sevenZip) {
    add(`reference.7z.source.${name}`, ["reference", "7z", "source"], (ctx) => {
      needTool("7z");
      const dir = stage(ctx, options);
      const archive = ctx.tmp("ref.7z");
      toolOrSkip(toolIn(ctx)("7z", ["a", "-t7z", ...flags, archive, ...fs.readdirSync(dir)], { cwd: dir }), `7z a -t7z ${flags.join(" ")}`);
      extractsGameBin(ctx, archive, `7z ${name}`);
      applyFromArchive(ctx, archive, `7z ${name}`);
    });
  }
  add("reference.7z.source.encrypted-content-rejected-cleanly", ["reference", "7z", "negative"], (ctx) => {
    needTool("7z");
    const dir = stage(ctx);
    const archive = ctx.tmp("enc.7z");
    toolMust(toolIn(ctx)("7z", ["a", "-t7z", "-psecret", archive, "game.bin"], { cwd: dir }), "7z a -psecret");
    cleanFailure(ctx, archive, /encrypt|passphrase|password/i, "7z with encrypted content");
  });
  add("reference.7z.source.encrypted-header-rejected-cleanly", ["reference", "7z", "negative"], (ctx) => {
    needTool("7z");
    const dir = stage(ctx);
    const archive = ctx.tmp("enc-header.7z");
    toolMust(toolIn(ctx)("7z", ["a", "-t7z", "-mhe=on", "-psecret", archive, "game.bin"], { cwd: dir }), "7z a -mhe=on");
    cleanFailure(ctx, archive, /encrypt|passphrase|password/i, "7z with encrypted header");
  });
  add("reference.7z.source.multi-volume-first-part", ["reference", "7z", "negative"], (ctx) => {
    needTool("7z");
    const dir = stage(ctx);
    const archive = ctx.tmp("vol.7z");
    toolMust(toolIn(ctx)("7z", ["a", "-t7z", "-v16k", "-m0=Copy", archive, "game.bin"], { cwd: dir }), "7z a -v16k");
    check(ctx.exists(`${archive}.002`), "7z did not split the archive into volumes");
    cleanFailure(ctx, `${archive}.001`, /./, "7z multi-volume (.001)", { rawFallback: true });
  });

  const zipMethods = [
    ["copy", ["-mm=Copy"]],
    ["deflate", ["-mm=Deflate"]],
    ["deflate-mx1", ["-mm=Deflate", "-mx=1"]],
    ["deflate-mx9", ["-mm=Deflate", "-mx=9"]],
    ["deflate64", ["-mm=Deflate64"]],
    ["bzip2", ["-mm=BZip2"]],
    ["lzma", ["-mm=LZMA"]],
    ["ppmd", ["-mm=PPMd"]],
    ["two-files", ["-mm=Deflate"], { readme: true }],
  ];
  for (const [name, flags, options = {}] of zipMethods) {
    add(`reference.zip.source.7z-${name}`, ["reference", "7z", "zip", "source"], (ctx) => {
      needTool("7z");
      const dir = stage(ctx, options);
      const archive = ctx.tmp("ref.zip");
      toolOrSkip(toolIn(ctx)("7z", ["a", "-tzip", ...flags, archive, ...fs.readdirSync(dir)], { cwd: dir }), `7z a -tzip ${flags.join(" ")}`);
      extractsGameBin(ctx, archive, `zip ${name}`);
      applyFromArchive(ctx, archive, `zip ${name}`);
    });
  }
  for (const [name, flags] of [["aes256", ["-mem=AES256"]], ["zipcrypto", ["-mem=ZipCrypto"]]]) {
    add(`reference.zip.source.7z-encrypted-${name}-rejected-cleanly`, ["reference", "7z", "zip", "negative"], (ctx) => {
      needTool("7z");
      const dir = stage(ctx);
      const archive = ctx.tmp("enc.zip");
      toolMust(toolIn(ctx)("7z", ["a", "-tzip", "-psecret", ...flags, archive, "game.bin"], { cwd: dir }), `7z a -tzip ${flags.join(" ")}`);
      cleanFailure(ctx, archive, /passphrase|password|encrypt/i, `zip ${name}`);
    });
  }
  for (const [name, type, file] of [["tar", "tar", "ref.tar"], ["gzip", "gzip", "ref.bin.gz"], ["bzip2", "bzip2", "ref.bin.bz2"], ["xz", "xz", "ref.bin.xz"]]) {
    add(`reference.7z.source.single-stream-${name}`, ["reference", "7z", "source"], (ctx) => {
      needTool("7z");
      const dir = stage(ctx);
      const archive = ctx.tmp(file);
      toolMust(toolIn(ctx)("7z", ["a", `-t${type}`, archive, "game.bin"], { cwd: dir }), `7z a -t${type}`);
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(archive, ctx.fx(PATCH), out), `apply from ${file}`);
      ctx.same(out, ctx.fx("rom/same.bin"), `${file}: patched output`);
    });
  }

  // =============================================================== rar made by rar, checked by unrar
  const rarMake = (ctx, flags, options = {}) => {
    const dir = stage(ctx, options);
    const archive = ctx.tmp("ref.rar");
    const tool = toolIn(ctx);
    toolOrSkip(tool("rar", ["a", "-inul", "-idq", ...flags, archive, ...fs.readdirSync(dir)], { cwd: dir }), `rar a ${flags.join(" ")}`);
    return { archive, tool };
  };
  for (const level of [0, 1, 2, 3, 4, 5]) {
    add(`reference.rar.source.m${level}`, ["reference", "rar", "source"], (ctx) => {
      needTool("rar", "unrar");
      const { archive, tool } = rarMake(ctx, [`-m${level}`]);
      toolMust(tool("unrar", ["t", "-inul", archive]), "unrar t (fixture sanity)");
      extractsGameBin(ctx, archive, `rar -m${level}`);
      applyFromArchive(ctx, archive, `rar -m${level}`);
    });
  }
  const rarVariants = [
    ["rar5-explicit", ["-ma5", "-m3"]],
    ["dictionary-128k", ["-md128k", "-m3"]],
    ["dictionary-1g", ["-md1g", "-m3"]],
    ["blake2-checksum", ["-htb", "-m3"]],
    ["recovery-record", ["-rr5p", "-m3"]],
    ["strip-paths", ["-ep1", "-m3"]],
    ["single-thread", ["-mt1", "-m3"]],
    ["no-timestamps", ["-tsm0", "-tsc0", "-tsa0", "-m3"]],
    ["solid", ["-s", "-m3"], { readme: true }],
    ["non-solid-two-files", ["-m3"], { readme: true }],
    ["solid-m5-two-files", ["-s", "-m5"], { readme: true }],
  ];
  for (const [name, flags, options = {}] of rarVariants) {
    add(`reference.rar.source.${name}`, ["reference", "rar", "source"], (ctx) => {
      needTool("rar", "unrar");
      const { archive, tool } = rarMake(ctx, flags, options);
      toolMust(tool("unrar", ["t", "-inul", archive]), "unrar t (fixture sanity)");
      extractsGameBin(ctx, archive, `rar ${name}`);
      applyFromArchive(ctx, archive, `rar ${name}`);
    });
  }
  add("reference.rar.source.rar4-format", ["reference", "rar", "source"], (ctx) => {
    needTool("rar", "unrar");
    const { archive, tool } = rarMake(ctx, ["-ma4", "-m3"]);
    toolMust(tool("unrar", ["t", "-inul", archive]), "unrar t (fixture sanity)");
    extractsGameBin(ctx, archive, "rar4");
    applyFromArchive(ctx, archive, "rar4");
  });
  add("reference.rar.source.encrypted-header-rejected-cleanly", ["reference", "rar", "negative"], (ctx) => {
    needTool("rar");
    const { archive } = rarMake(ctx, ["-hpsecret", "-m3"]);
    cleanFailure(ctx, archive, /encrypt|passphrase|password/i, "rar with encrypted header");
  });
  add("reference.rar.source.encrypted-content-rejected-cleanly", ["reference", "rar", "negative"], (ctx) => {
    needTool("rar");
    const { archive } = rarMake(ctx, ["-psecret", "-m3"]);
    cleanFailure(ctx, archive, /encrypt|passphrase|password/i, "rar with encrypted content");
  });
  add("reference.rar.source.multi-volume-first-part", ["reference", "rar", "negative"], (ctx) => {
    needTool("rar");
    const { archive } = rarMake(ctx, ["-v16k", "-m0"]);
    const first = [archive.replace(/\.rar$/, ".part1.rar"), archive.replace(/\.rar$/, ".part01.rar"), archive].find((file) => ctx.exists(file));
    check(first, () => `rar -v did not write a first volume (have ${fs.readdirSync(ctx.work).join(",")})`);
    cleanFailure(ctx, first, /multi|volume|part|support/i, "rar multi-volume (first part)");
  });
  add("reference.rar.source.truncated-and-corrupt", ["reference", "rar", "negative", "fuzz"], (ctx) => {
    needTool("rar");
    const { archive } = rarMake(ctx, ["-m3"]);
    const bytes = fs.readFileSync(archive);
    const original = ctx.bytes("rom/base.bin");
    const cuts = new Set([0, 1, 7, 8, 12, 20, 40, bytes.length - 1, bytes.length - 8, bytes.length - 40]);
    for (let index = 1; index < 24; index++) cuts.add(Math.floor((bytes.length * index) / 24));
    for (const cut of [...cuts].filter((value) => value >= 0 && value < bytes.length).sort((a, b) => a - b)) {
      const input = ctx.write(`cut/cut-${cut}.rar`, bytes.subarray(0, cut));
      const dir = ctx.tmp(`cut/out-${cut}`);
      const run = ctx.run(["extract", "--input", input, "--output", dir]);
      check(!run.timedOut && !run.panic, () => `rar cut ${cut}/${bytes.length}: ${ctx.describe(run)}`);
      if (run.code !== 0) check(filesUnder(dir).length === 0, `rar cut ${cut}: failed extract left output`);
      else {
        const files = filesUnder(dir);
        check(files.length === 1 && fs.readFileSync(files[0]).equals(original), `rar cut ${cut}/${bytes.length}: extracted with exit 0 but not to the packed ROM`);
      }
    }
    for (let at = 0; at < bytes.length; at += Math.max(1, Math.floor(bytes.length / 96))) {
      const mutated = Buffer.from(bytes);
      mutated[at] ^= 0xff;
      const input = ctx.write(`flip/flip-${at}.rar`, mutated);
      const dir = ctx.tmp(`flip/out-${at}`);
      const run = ctx.run(["extract", "--input", input, "--output", dir]);
      check(!run.timedOut && !run.panic, () => `rar flip ${at}/${bytes.length}: ${ctx.describe(run)}`);
      if (run.code !== 0) check(filesUnder(dir).length === 0, `rar flip ${at}: failed extract left output`);
      else {
        const files = filesUnder(dir);
        check(files.length !== 1 || fs.readFileSync(files[0]).equals(original), `rar flip ${at}/${bytes.length}: extracted with exit 0 to different bytes (stored CRC32/BLAKE2 not enforced)`);
      }
    }
  });

  // =============================================================== rom-weaver zip / 7z -> 7z
  const sevenZipReads = (ctx, archive, expectedPath, what) => {
    const tool = toolIn(ctx);
    toolMust(tool("7z", ["t", archive]), `7z t ${what}`);
    const listing = toolMust(tool("7z", ["l", "-slt", archive]), `7z l ${what}`).text;
    check(/Path = /.test(listing), `7z l produced no listing for ${what}`);
    const payload = toolMust(tool("7z", ["x", "-so", archive]), `7z x -so ${what}`).stdout;
    check(Buffer.from(payload).equals(fs.readFileSync(expectedPath)), () => `${what}: bytes from 7z x differ from the patched ROM (${payload.length} vs ${fs.statSync(expectedPath).size})`);
  };
  const levels = ["min", "medium", "max"];
  for (const [format, codecs] of [["zip", ["store", "deflate", "zstd"]], ["7z", ["lzma2"]]]) {
    for (const codec of codecs) {
      for (const level of codec === "store" ? [null] : levels) {
        add(`reference.${format}.output.7z-reads.${codec}${level ? `.level-${level}` : ""}`, ["reference", "7z", format, "output"], (ctx) => {
          needTool("7z");
          if (codec === "zstd") {
            const codecs7z = toolIn(ctx)("7z", ["i"]).text;
            // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
            if (!/zstd/i.test(codecs7z)) skip("this 7z build has no Zstandard method, so a zstd-in-zip result cannot be read by the reference tool");
          }
          const out = ctx.tmp(`out.${format}`);
          const extra = ["--compress-codec", codec, ...(level ? ["--compress-level", level] : [])];
          ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx(PATCH), out, extra, { compress: true }), `rom-weaver apply -> ${format}/${codec}`);
          sevenZipReads(ctx, out, ctx.fx("rom/same.bin"), `${format} ${codec}${level ? ` ${level}` : ""}`);
        });
      }
    }
  }
  for (const format of ["zip", "7z"]) {
    add(`reference.${format}.output.7z-reads.compress-command-multi-mib`, ["reference", "7z", format, "output"], (ctx) => {
      needTool("7z");
      const out = ctx.tmp(`big.${format}`);
      ctx.ok(ctx.run(["compress", "--input", ctx.fx("reference/bin/tgt.bin"), "--output", out, "--force"]), `rom-weaver compress -> ${format}`);
      sevenZipReads(ctx, out, ctx.fx("reference/bin/tgt.bin"), `compress ${format}`);
    });
    add(`reference.${format}.output.7z-reads.incompressible-and-empty-payloads`, ["reference", "7z", format, "output", "edge"], (ctx) => {
      needTool("7z");
      for (const [label, bytes] of [["random", Buffer.from(prngBytes(300000, 0x99))], ["zeros", Buffer.alloc(300000)], ["one-byte", Buffer.from([0x42])]]) {
        const input = ctx.write(`in/${label}.bin`, bytes);
        const out = ctx.tmp(`${label}.${format}`);
        ctx.ok(ctx.run(["compress", "--input", input, "--output", out, "--force"]), `rom-weaver compress ${label}`);
        sevenZipReads(ctx, out, input, `${format} ${label}`);
      }
    });
  }
  add("reference.7z.output.7z-t-reports-no-warnings", ["reference", "7z", "output"], (ctx) => {
    needTool("7z");
    const out = ctx.tmp("out.7z");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx(PATCH), out, [], { compress: true }), "apply -> 7z");
    const result = toolIn(ctx)("7z", ["t", out]);
    check(result.ok && /Everything is Ok/.test(result.text) && !/^(WARNING|ERROR)/im.test(result.text), () => `7z reported problems for a fresh rom-weaver 7z: ${describeTool(result)}`);
  });
};
