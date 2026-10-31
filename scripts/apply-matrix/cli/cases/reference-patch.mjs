// Patch parity against the reference tools: patches written by xdelta3 / flips must apply with rom-weaver to the
// exact target, and patches written by rom-weaver must be decoded by xdelta3 / flips to the exact target.
import fs from "node:fs";
import path from "node:path";
import { add, check, fail, skip } from "../lib/harness.mjs";
import { describeTool, needTool, parseIps, prngBytes, toolIn, toolMust, toolOrSkip } from "../lib/reference-tools.mjs";

const SRC = "reference/bin/src.bin";
const TGT = "reference/bin/tgt.bin";

/**
 * 3 MiB source and a target built from moved blocks, a random insertion, a zero run, a repeated pattern, a block that
 * reaches back to early source data and a target-internal repeat: exercises ADD, RUN and COPY (source and target
 * copies) across several xdelta3 windows.
 */
const buildBlocks = () => {
  const size = 3 * 1024 * 1024;
  const source = prngBytes(size, 0x13572468);
  const insert = prngBytes(100 * 1024, 0xabcdef01);
  const parts = [
    source.subarray(0, 700 * 1024),
    insert,
    source.subarray(1024 * 1024, 2 * 1024 * 1024),
    new Uint8Array(300 * 1024),
    Uint8Array.from({ length: 64 * 1024 }, (_, index) => (index * 7) & 0xff),
    source.subarray(200 * 1024, 300 * 1024),
    insert.subarray(0, 40 * 1024),
    prngBytes(50 * 1024, 0x2468ace0),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { source, target: out };
};

const SMALL = [
  ["same", "rom/base.bin", "rom/same.bin"],
  ["grow", "rom/base.bin", "rom/grow.bin"],
  ["shrink", "rom/base.bin", "rom/shrink.bin"],
  ["rle", "rom/base.bin", "rom/rle.bin"],
];
const PAIRS = [...SMALL, ["blocks", SRC, TGT]];

export const register = ({ fixtures }) => {
  const define = (name, purpose, how, build) => fixtures.define(name, { where: "cache", purpose, how, deterministic: true, build });
  define(SRC, "3 MiB pseudo-random source for the reference-tool patch cases", "cases/reference-patch.mjs buildBlocks()", () => buildBlocks().source);
  define(TGT, "target built from moved/inserted/zero/repeated blocks of reference/bin/src.bin", "buildBlocks()", () => buildBlocks().target);

  const emptyFile = (ctx, name = "empty.bin") => ctx.write(name, Buffer.alloc(0));
  const rwApply = (ctx, input, patch, out) => ctx.ok(ctx.apply(input, patch, out), `rom-weaver apply ${path.basename(patch)}`);

  // =============================================================== xdelta3 -> rom-weaver
  const xdelta3Variants = [
    ["default", []],
    ...Array.from({ length: 10 }, (_, level) => [`level-${level}`, [`-${level}`]]),
    ["secondary-none", ["-S", "none"]],
    ["secondary-djw", ["-S", "djw"]],
    ["secondary-fgk", ["-S", "fgk"]],
    ["secondary-lzma", ["-S", "lzma"]],
    ["source-window-16k", ["-B", "16384"]],
    ["source-window-1m", ["-B", "1048576"]],
    ["input-window-16k", ["-W", "16384"]],
    ["input-window-64k", ["-W", "65536"]],
    ["input-window-1m", ["-W", "1048576"]],
    ["instruction-buffer-0", ["-I", "0"]],
    ["no-checksum", ["-n"]],
    ["no-compress-D", ["-D"]],
    ["no-small-match-N", ["-N"]],
    ["no-recompress-R", ["-R"]],
    ["app-header", ["-A=reference-app-header"]],
    ["app-header-empty", ["-A"]],
    ["custom-string-match", ["-C", "9,3,4,8,2,36,70"]],
    ["max-effort-lzma-windows", ["-9", "-S", "lzma", "-W", "65536", "-B", "65536"]],
    ["fast-no-checksum", ["-0", "-n"]],
    ["djw-small-windows", ["-3", "-W", "16384", "-S", "djw"]],
  ];
  for (const [name, flags] of xdelta3Variants) {
    add(`reference.xdelta3.apply.${name}`, ["reference", "xdelta3", "xdelta"], (ctx) => {
      needTool("xdelta3");
      const tool = toolIn(ctx);
      for (const [pair, source, target] of PAIRS) {
        const patch = ctx.tmp(`${pair}.xdelta`);
        toolOrSkip(tool("xdelta3", ["-e", "-f", ...flags, "-s", ctx.fx(source), ctx.fx(target), patch]), `xdelta3 -e ${flags.join(" ")} (${pair})`);
        const out = ctx.tmp(`${pair}.out`);
        rwApply(ctx, ctx.fx(source), patch, out);
        ctx.same(out, ctx.fx(target), `${pair}: rom-weaver output vs target`);
      }
    });
  }
  add("reference.xdelta3.apply.sourceless", ["reference", "xdelta3", "xdelta"], (ctx) => {
    needTool("xdelta3");
    const tool = toolIn(ctx);
    const empty = emptyFile(ctx);
    for (const [pair, source, target] of PAIRS) {
      const patch = ctx.tmp(`${pair}.xdelta`);
      toolMust(tool("xdelta3", ["-e", "-f", ctx.fx(target), patch]), "xdelta3 -e (no -s: source-less)");
      for (const [label, input] of [["empty-input", empty], ["unrelated-input", ctx.fx(source)]]) {
        const out = ctx.tmp(`${pair}.${label}.out`);
        rwApply(ctx, input, patch, out);
        ctx.same(out, ctx.fx(target), `${pair} (${label}): source-less patch output`);
      }
    }
  });
  add("reference.xdelta3.apply.empty-source-file", ["reference", "xdelta3", "xdelta"], (ctx) => {
    needTool("xdelta3");
    const tool = toolIn(ctx);
    const empty = emptyFile(ctx);
    for (const [pair, , target] of PAIRS) {
      const patch = ctx.tmp(`${pair}.xdelta`);
      toolMust(tool("xdelta3", ["-e", "-f", "-s", empty, ctx.fx(target), patch]), "xdelta3 -e -s <empty>");
      const out = ctx.tmp(`${pair}.out`);
      rwApply(ctx, empty, patch, out);
      ctx.same(out, ctx.fx(target), `${pair}: empty-source patch output`);
    }
  });
  add("reference.xdelta3.apply.empty-target", ["reference", "xdelta3", "xdelta"], (ctx) => {
    needTool("xdelta3");
    const tool = toolIn(ctx);
    const empty = emptyFile(ctx);
    const patch = ctx.tmp("to-empty.xdelta");
    toolMust(tool("xdelta3", ["-e", "-f", "-s", ctx.fx("rom/base.bin"), empty, patch]), "xdelta3 -e (empty target)");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("rom/base.bin"), patch, out);
    check(fs.statSync(out).size === 0, () => `expected an empty output, got ${fs.statSync(out).size} bytes`);
  });
  add("reference.xdelta3.apply.identical-source-and-target", ["reference", "xdelta3", "xdelta"], (ctx) => {
    needTool("xdelta3");
    const tool = toolIn(ctx);
    const patch = ctx.tmp("same.xdelta");
    toolMust(tool("xdelta3", ["-e", "-f", "-s", ctx.fx(SRC), ctx.fx(SRC), patch]), "xdelta3 -e (identical)");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx(SRC), patch, out);
    ctx.same(out, ctx.fx(SRC), "identical-file patch output");
  });
  for (const [name, flags] of [["default", []], ["max-lzma", ["-9", "-S", "lzma"]], ["big-windows", ["-W", "4194304", "-B", "8388608"]], ["small-windows", ["-W", "262144", "-B", "262144"]]]) {
    add(`reference.xdelta3.apply.large-34mib.${name}`, ["reference", "xdelta3", "xdelta", "large"], (ctx) => {
      needTool("xdelta3");
      const tool = toolIn(ctx);
      const patch = ctx.tmp("large.xdelta");
      toolMust(tool("xdelta3", ["-e", "-f", ...flags, "-s", ctx.fx("large/source.bin"), ctx.fx("large/target.bin"), patch]), `xdelta3 -e ${flags.join(" ")} (34 MiB)`);
      const out = ctx.tmp("large.out");
      rwApply(ctx, ctx.fx("large/source.bin"), patch, out);
      ctx.same(out, ctx.fx("large/target.bin"), "34 MiB xdelta3 patch output");
    });
  }
  add("reference.xdelta3.apply.wrong-source-rejected", ["reference", "xdelta3", "xdelta", "negative"], (ctx) => {
    needTool("xdelta3");
    const tool = toolIn(ctx);
    const patch = ctx.tmp("same.xdelta");
    toolMust(tool("xdelta3", ["-e", "-f", "-s", ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch]), "xdelta3 -e");
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/wrong.bin"), patch, out);
    ctx.failed(result, { what: "xdelta3 patch (with its own Adler-32) applied to a wrong source" });
    check(!ctx.exists(out), "failed apply left an output");
  });

  // =============================================================== rom-weaver -> xdelta3
  const secondaries = ["none", "lzma", "djw", "fgk", "auto"];
  for (const format of ["xdelta", "vcdiff"]) {
    for (const secondary of format === "xdelta" ? secondaries : ["none"]) {
      add(`reference.xdelta3.decode.rom-weaver-${format}.secondary-${secondary}`, ["reference", "xdelta3", format], (ctx) => {
        needTool("xdelta3");
        const tool = toolIn(ctx);
        const extra = [...PAIRS, ["identical", SRC, SRC]];
        for (const [pair, source, target] of extra) {
          const patch = ctx.tmp(`${pair}.${format}`);
          ctx.ok(ctx.run(["patch", "create", "--original", ctx.fx(source), "--modified", ctx.fx(target), "--output", patch, ...(format === "xdelta" ? ["--xdelta-secondary", secondary] : [])]), `rom-weaver patch create ${pair}`);
          const decoded = ctx.tmp(`${pair}.decoded`);
          const result = tool("xdelta3", ["-d", "-f", "-s", ctx.fx(source), patch, decoded]);
          if (!result.ok && /not compiled|unrecognized .*secondary/i.test(result.text)) skip(`xdelta3 build cannot decode ${secondary} secondary compression: ${describeTool(result)}`);
          toolMust(result, `xdelta3 -d ${path.basename(patch)}`);
          ctx.same(decoded, ctx.fx(target), `${pair}: xdelta3 -d of rom-weaver ${format} (${secondary})`);
        }
      });
    }
    for (const label of ["empty-original", "empty-modified"]) {
      add(`reference.xdelta3.decode.rom-weaver-${format}.${label}`, ["reference", "xdelta3", format, "edge"], (ctx) => {
        needTool("xdelta3");
        const empty = emptyFile(ctx);
        const originalPath = label === "empty-original" ? empty : ctx.fx("rom/base.bin");
        const modifiedPath = label === "empty-original" ? ctx.fx("rom/same.bin") : empty;
        const patch = ctx.tmp(`${label}.${format}`);
        ctx.ok(ctx.run(["patch", "create", "--original", originalPath, "--modified", modifiedPath, "--output", patch]), `rom-weaver patch create ${label}`);
        const decoded = ctx.tmp(`${label}.decoded`);
        toolMust(toolIn(ctx)("xdelta3", ["-d", "-f", "-s", originalPath, patch, decoded]), `xdelta3 -d ${label}`);
        ctx.same(decoded, modifiedPath, `${label}: xdelta3 -d output`);
      });
    }
  }
  add("reference.xdelta3.decode.rom-weaver-xdelta.large-34mib", ["reference", "xdelta3", "xdelta", "large"], (ctx) => {
    needTool("xdelta3");
    const patch = ctx.tmp("large.xdelta");
    ctx.ok(ctx.run(["patch", "create", "--original", ctx.fx("large/source.bin"), "--modified", ctx.fx("large/target.bin"), "--output", patch]), "rom-weaver patch create (34 MiB)");
    const decoded = ctx.tmp("large.decoded");
    toolMust(toolIn(ctx)("xdelta3", ["-d", "-f", "-s", ctx.fx("large/source.bin"), patch, decoded]), "xdelta3 -d (34 MiB)");
    ctx.same(decoded, ctx.fx("large/target.bin"), "34 MiB: xdelta3 -d of rom-weaver xdelta");
  });
  add("reference.xdelta3.decode.rom-weaver-xdelta.checksum-detects-wrong-source", ["reference", "xdelta3", "xdelta", "negative"], (ctx) => {
    needTool("xdelta3");
    const patch = ctx.tmp("same.xdelta");
    ctx.ok(ctx.run(["patch", "create", "--original", ctx.fx("rom/base.bin"), "--modified", ctx.fx("rom/same.bin"), "--output", patch]), "rom-weaver patch create");
    const result = toolIn(ctx)("xdelta3", ["-d", "-f", "-s", ctx.fx("rom/wrong.bin"), patch, ctx.tmp("decoded.bin")]);
    check(!result.ok, "xdelta3 -d accepted a wrong source for a rom-weaver xdelta patch (the patch carries no usable checksum)");
  });

  // =============================================================== flips -> rom-weaver
  const flipsStyles = [
    ["ips", "ips", ["--ips"]],
    ["bps-default", "bps", ["--bps"]],
    ["bps-delta", "bps", ["--bps-delta"]],
    ["bps-delta-moremem", "bps", ["--bps-delta-moremem"]],
    ["bps-linear", "bps", ["--bps-linear"]],
  ];
  const createWithFlips = (ctx, flags, ext, base, target, name) => {
    const patch = ctx.tmp(`${name}.${ext}`);
    toolMust(toolIn(ctx)("flips", ["--create", ...flags, base, target, patch]), `flips --create ${flags.join(" ")}`);
    check(ctx.exists(patch), "flips wrote no patch");
    return patch;
  };
  for (const [style, ext, styleFlags] of flipsStyles) {
    for (const exact of [false, true]) {
      add(`reference.flips.apply.${style}${exact ? ".exact" : ""}`, ["reference", "flips", ext], (ctx) => {
        needTool("flips");
        for (const [pair, source, target] of PAIRS) {
          const patch = createWithFlips(ctx, [...styleFlags, ...(exact ? ["--exact"] : [])], ext, ctx.fx(source), ctx.fx(target), pair);
          const out = ctx.tmp(`${pair}.out`);
          rwApply(ctx, ctx.fx(source), patch, out);
          ctx.same(out, ctx.fx(target), `${pair}: rom-weaver output vs target`);
        }
      });
    }
  }
  for (const style of ["bps-delta", "bps-linear"]) {
    add(`reference.flips.apply.${style}.large-34mib`, ["reference", "flips", "bps", "large"], (ctx) => {
      needTool("flips");
      const patch = createWithFlips(ctx, [`--${style}`], "bps", ctx.fx("large/source.bin"), ctx.fx("large/target.bin"), "large");
      const out = ctx.tmp("large.out");
      rwApply(ctx, ctx.fx("large/source.bin"), patch, out);
      ctx.same(out, ctx.fx("large/target.bin"), "34 MiB flips BPS output");
    });
  }
  add("reference.flips.apply.ips-eof-address", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const patch = createWithFlips(ctx, ["--ips"], "ips", ctx.fx("ips-eof/base.bin"), ctx.fx("ips-eof/target.bin"), "eof");
    const parsed = parseIps(fs.readFileSync(patch));
    const spans = parsed.records.some((record) => record.offset <= 0x454f46 && 0x454f46 < record.offset + record.length);
    if (!spans) skip("flips did not emit a record covering the EOF address 0x454F46 for this pair");
    check(!parsed.records.some((record) => record.offset === 0x454f46), "flips emitted a record starting at the EOF address (reference tool quirk changed)");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("ips-eof/base.bin"), patch, out);
    ctx.same(out, ctx.fx("ips-eof/target.bin"), "rom-weaver output for flips' EOF-address-avoiding IPS");
  });
  add("reference.flips.apply.ips-rle-records", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const patch = createWithFlips(ctx, ["--ips"], "ips", ctx.fx("rom/base.bin"), ctx.fx("rom/rle.bin"), "rle");
    if (!parseIps(fs.readFileSync(patch)).records.some((record) => record.rle)) skip("flips emitted no RLE record for the 200 x 0xAA run");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("rom/base.bin"), patch, out);
    ctx.same(out, ctx.fx("rom/rle.bin"), "rom-weaver output for flips RLE IPS");
  });
  add("reference.flips.apply.ips-truncate-extension", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const patch = createWithFlips(ctx, ["--ips"], "ips", ctx.fx("rom/base.bin"), ctx.fx("rom/shrink.bin"), "shrink");
    const parsed = parseIps(fs.readFileSync(patch));
    if (parsed.truncate === null) skip("flips emitted no truncate extension for a shrinking target");
    check(parsed.truncate === fs.statSync(ctx.fx("rom/shrink.bin")).size, () => `flips truncate size ${parsed.truncate} != target size`);
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("rom/base.bin"), patch, out);
    ctx.same(out, ctx.fx("rom/shrink.bin"), "rom-weaver output for flips IPS with truncate extension");
  });
  add("reference.flips.apply.ips-grow-appends", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const patch = createWithFlips(ctx, ["--ips"], "ips", ctx.fx("rom/base.bin"), ctx.fx("rom/grow.bin"), "grow");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("rom/base.bin"), patch, out);
    ctx.same(out, ctx.fx("rom/grow.bin"), "rom-weaver output for flips IPS that grows the ROM");
  });
  add("reference.flips.apply.bps-metadata-manifest", ["reference", "flips", "bps", "edge"], (ctx) => {
    needTool("flips");
    const manifest = ctx.write("meta.xml", '<?xml version="1.0" encoding="UTF-8"?>\n<patch><info><title>reference metadata</title></info></patch>\n');
    const tool = toolIn(ctx);
    const plain = createWithFlips(ctx, ["--bps"], "bps", ctx.fx("rom/base.bin"), ctx.fx("rom/grow.bin"), "plain");
    const withMeta = ctx.tmp("meta.bps");
    toolMust(tool("flips", ["--create", "--bps", `--manifest=${manifest}`, ctx.fx("rom/base.bin"), ctx.fx("rom/grow.bin"), withMeta]), "flips --create --manifest");
    check(fs.statSync(withMeta).size > fs.statSync(plain).size, "flips did not embed the manifest in the BPS");
    const out = ctx.tmp("out.bin");
    rwApply(ctx, ctx.fx("rom/base.bin"), withMeta, out);
    ctx.same(out, ctx.fx("rom/grow.bin"), "rom-weaver output for flips BPS with metadata");
  });

  // SMC-headered SNES pair: flips (without --exact) strips the 512-byte header before diffing BPS and re-adds it when
  // applying; rom-weaver strips it and writes a headerless ROM (documented in the header.* cases).
  const smcPair = (ctx) => {
    const body = Buffer.from(prngBytes(0x40000, 0x5a5a));
    const target = Buffer.from(body);
    target.fill(0x58, 0x100, 0x110);
    target[0x8000] ^= 0xff;
    const header = Buffer.alloc(512);
    return { base: ctx.write("snes/base.smc", Buffer.concat([header, body])), target: ctx.write("snes/target.smc", Buffer.concat([header, target])), body, targetBody: target };
  };
  add("reference.flips.apply.bps-smc-header.exact", ["reference", "flips", "bps", "header"], (ctx) => {
    needTool("flips");
    const { base, target } = smcPair(ctx);
    const patch = createWithFlips(ctx, ["--bps", "--exact"], "bps", base, target, "exact");
    const out = ctx.tmp("out.smc");
    rwApply(ctx, base, patch, out);
    const produced = [out, out.replace(/\.smc$/, ".sfc")].find((file) => ctx.exists(file));
    const flipsOut = ctx.tmp("flips-out.smc");
    toolMust(toolIn(ctx)("flips", ["--apply", "--exact", patch, base, flipsOut]), "flips --apply --exact");
    ctx.same(flipsOut, target, "flips --apply --exact output vs target");
    check(produced, "rom-weaver wrote no output");
    ctx.same(produced, target, "rom-weaver output for an --exact flips BPS on a headered ROM");
  });
  add("reference.flips.apply.bps-smc-header.stripped", ["reference", "flips", "bps", "header"], (ctx) => {
    needTool("flips");
    const { base, target, targetBody } = smcPair(ctx);
    const patch = createWithFlips(ctx, ["--bps"], "bps", base, target, "stripped");
    const flipsOut = ctx.tmp("flips-out.smc");
    toolMust(toolIn(ctx)("flips", ["--apply", patch, base, flipsOut]), "flips --apply");
    ctx.same(flipsOut, target, "flips --apply output vs headered target");
    const out = ctx.tmp("out.smc");
    rwApply(ctx, base, patch, out);
    const produced = [out, out.replace(/\.smc$/, ".sfc")].find((file) => ctx.exists(file));
    check(produced, "rom-weaver wrote no output");
    const bytes = fs.readFileSync(produced);
    check(bytes.equals(targetBody), () => `rom-weaver output (${bytes.length} bytes) is neither flips' headered target nor the headerless target body`);
    ctx.note("flips re-adds the 512-byte SMC header on apply; rom-weaver writes the headerless ROM (and renames .smc to .sfc) by design");
  });

  // =============================================================== rom-weaver -> flips
  const rwCreate = (ctx, ext, original, modified, name) => {
    const patch = ctx.tmp(`${name}.${ext}`);
    ctx.ok(ctx.run(["patch", "create", "--original", original, "--modified", modified, "--output", patch]), `rom-weaver patch create ${name}.${ext}`);
    return patch;
  };
  const flipsApply = (ctx, patch, source, out, flags = []) => {
    const result = toolIn(ctx)("flips", ["--apply", ...flags, patch, source, out]);
    toolMust(result, `flips --apply ${path.basename(patch)}`);
    check(ctx.exists(out), () => `flips wrote no output: ${describeTool(result)}`);
  };
  for (const ext of ["ips", "bps", "ups"]) {
    for (const exact of ext === "bps" ? [false, true] : [false]) {
      add(`reference.flips.decode.rom-weaver-${ext}${exact ? ".exact" : ""}`, ["reference", "flips", ext], (ctx) => {
        needTool("flips");
        for (const [pair, source, target] of PAIRS) {
          const patch = rwCreate(ctx, ext, ctx.fx(source), ctx.fx(target), pair);
          const out = ctx.tmp(`${pair}.flips.out`);
          flipsApply(ctx, patch, ctx.fx(source), out, exact ? ["--exact"] : []);
          ctx.same(out, ctx.fx(target), `${pair}: flips --apply of rom-weaver ${ext}`);
        }
      });
    }
  }
  add("reference.flips.decode.rom-weaver-ips.eof-address", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const patch = rwCreate(ctx, "ips", ctx.fx("ips-eof/base.bin"), ctx.fx("ips-eof/target.bin"), "eof");
    const out = ctx.tmp("out.bin");
    flipsApply(ctx, patch, ctx.fx("ips-eof/base.bin"), out);
    ctx.same(out, ctx.fx("ips-eof/target.bin"), "flips --apply of rom-weaver IPS across the EOF address");
  });
  add("reference.flips.decode.rom-weaver-ips.truncate-and-rle", ["reference", "flips", "ips", "edge"], (ctx) => {
    needTool("flips");
    const shrink = rwCreate(ctx, "ips", ctx.fx("rom/base.bin"), ctx.fx("rom/shrink.bin"), "shrink");
    const out = ctx.tmp("shrink.out");
    flipsApply(ctx, shrink, ctx.fx("rom/base.bin"), out);
    ctx.same(out, ctx.fx("rom/shrink.bin"), "flips --apply of rom-weaver IPS that shrinks the ROM");
    const rle = rwCreate(ctx, "ips", ctx.fx("rom/base.bin"), ctx.fx("rom/rle.bin"), "rle");
    const rleOut = ctx.tmp("rle.out");
    flipsApply(ctx, rle, ctx.fx("rom/base.bin"), rleOut);
    ctx.same(rleOut, ctx.fx("rom/rle.bin"), "flips --apply of rom-weaver IPS with an RLE run");
  });
  add("reference.flips.decode.rom-weaver-bps.large-34mib", ["reference", "flips", "bps", "large"], (ctx) => {
    needTool("flips");
    const patch = rwCreate(ctx, "bps", ctx.fx("large/source.bin"), ctx.fx("large/target.bin"), "large");
    const out = ctx.tmp("large.out");
    flipsApply(ctx, patch, ctx.fx("large/source.bin"), out);
    ctx.same(out, ctx.fx("large/target.bin"), "flips --apply of a 34 MiB rom-weaver BPS");
  });
  add("reference.flips.decode.rom-weaver-bps.wrong-source-rejected", ["reference", "flips", "bps", "negative"], (ctx) => {
    needTool("flips");
    const patch = rwCreate(ctx, "bps", ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), "same");
    const out = ctx.tmp("out.bin");
    const result = toolIn(ctx)("flips", ["--apply", patch, ctx.fx("rom/wrong.bin"), out]);
    if (result.ok && ctx.exists(out) && fs.readFileSync(out).equals(fs.readFileSync(ctx.fx("rom/same.bin")))) fail("flips applied a rom-weaver BPS to a wrong source and produced the target");
    ctx.note(`flips on a wrong source: ${describeTool(result)}`);
  });
  add("reference.flips.decode.rom-weaver-bps.smc-header-pair", ["reference", "flips", "bps", "header"], (ctx) => {
    needTool("flips");
    const { base, target } = smcPair(ctx);
    const patch = rwCreate(ctx, "bps", base, target, "smc");
    const out = ctx.tmp("flips.smc");
    flipsApply(ctx, patch, base, out, ["--exact"]);
    ctx.same(out, target, "flips --apply --exact of a rom-weaver BPS made from SMC-headered ROMs");
  });
};
