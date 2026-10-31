// Cross product the per-format batteries do not cover: every creatable patch format x {patch inside each archive type,
// ROM inside each archive type, patch and ROM in one archive, compressed outputs with each codec/level}.
import fs from "node:fs";
import path from "node:path";
import { add, check, skip } from "../lib/harness.mjs";
import { have } from "../lib/fixture-defs.mjs";
import { filesUnder, needTool, toolIn, toolMust } from "../lib/reference-tools.mjs";

const FORMATS = ["ips", "ips32", "solid", "bps", "ups", "vcdiff", "xdelta", "gdiff", "aps", "apsgba", "rup", "ppf", "pat", "ebp", "bdf", "dps", "mod"];
const flagsFor = (fmt) => (fmt === "mod" ? ["--ignore-checksum-validation"] : []);
const patchFx = (fmt) => `patches/rw/same.${fmt}`;

/** [label, tool, builder(ctx, fileName) -> archive path] for archives holding one or more files. */
const ARCHIVES = [
  ["zip", "zip", (ctx, names, out) => ["zip", ["-q", out, ...names]]],
  ["7z", "7z", (ctx, names, out) => ["7z", ["a", "-t7z", out, ...names]]],
  ["tar", "tar", (ctx, names, out) => ["tar", ["-cf", out, ...names]]],
  ["tar.gz", "tar", (ctx, names, out) => ["tar", ["-czf", out, ...names]]],
  ["tar.xz", "tar", (ctx, names, out) => ["tar", ["-cJf", out, ...names]]],
  ["tar.bz2", "tar", (ctx, names, out) => ["tar", ["-cjf", out, ...names]]],
  ["rar", "rar", (ctx, names, out) => ["rar", ["a", "-idq", out, ...names]]],
];
const SINGLE = [
  ["gz", "gzip", ["-c"]],
  ["bz2", "bzip2", ["-c"]],
  ["xz", "xz", ["-c"]],
  ["zst", "zstd", ["-q", "-c"]],
  ["lz4", "lz4", ["-q", "-c"]],
];

export const register = () => {
  for (const fmt of FORMATS) {
    const tag = ["apply-matrix", fmt];
    for (const [label, tool, build] of ARCHIVES) {
      add(`apply-matrix.${fmt}.patch-in-${label}`, [...tag, "container", label], (ctx) => {
        if (!have(tool)) skip(`${tool} not installed`);
        const patchName = `patch.${fmt}`;
        ctx.write(`stage/${patchName}`, fs.readFileSync(ctx.fx(patchFx(fmt))));
        const archive = ctx.tmp(`patch.${label}`);
        const [cmd, args] = build(ctx, [patchName], archive);
        toolMust(toolIn(ctx)(cmd, args, { cwd: path.join(ctx.work, "stage") }), `${cmd} build`);
        const out = ctx.tmp("out.bin");
        ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), archive, out, flagsFor(fmt)), `apply ${fmt} patch from ${label}`);
        ctx.same(out, ctx.fx("rom/same.bin"), `${fmt} via ${label}`);
      });
      add(`apply-matrix.${fmt}.rom-in-${label}`, [...tag, "container", label], (ctx) => {
        if (!have(tool)) skip(`${tool} not installed`);
        ctx.write("stage/game.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
        const archive = ctx.tmp(`rom.${label}`);
        const [cmd, args] = build(ctx, ["game.bin"], archive);
        toolMust(toolIn(ctx)(cmd, args, { cwd: path.join(ctx.work, "stage") }), `${cmd} build`);
        const out = ctx.tmp("out.bin");
        ctx.ok(ctx.apply(archive, ctx.fx(patchFx(fmt)), out, flagsFor(fmt)), `apply ${fmt} to ROM from ${label}`);
        ctx.same(out, ctx.fx("rom/same.bin"), `${fmt} ROM via ${label}`);
      });
    }
    add(`apply-matrix.${fmt}.rom-and-patch-in-one-zip`, [...tag, "container", "zip"], (ctx) => {
      needTool("zip");
      ctx.write("stage/game.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
      ctx.write(`stage/patch.${fmt}`, fs.readFileSync(ctx.fx(patchFx(fmt))));
      const archive = ctx.tmp("both.zip");
      toolMust(toolIn(ctx)("zip", ["-q", archive, "game.bin", `patch.${fmt}`], { cwd: path.join(ctx.work, "stage") }), "zip");
      const out = ctx.tmp("out.bin");
      const result = ctx.apply(archive, archive, out, flagsFor(fmt));
      // Same archive as ROM and patch source: either works, or it fails cleanly asking for a selection.
      if (result.code === 0) ctx.same(out, ctx.fx("rom/same.bin"), `${fmt} single-archive`);
      else ctx.failed(result, { what: "rom+patch in one archive" });
    });
    for (const [label, tool, flags] of SINGLE) {
      add(`apply-matrix.${fmt}.patch-in-${label}`, [...tag, "container", label], (ctx) => {
        if (!have(tool)) skip(`${tool} not installed`);
        const name = `patch.${fmt}`;
        ctx.write(`stage/${name}`, fs.readFileSync(ctx.fx(patchFx(fmt))));
        const archive = ctx.tmp(`${name}.${label}`);
        const packed = toolIn(ctx)(tool, [...flags, name], { cwd: path.join(ctx.work, "stage") });
        toolMust(packed, `${tool} pack`);
        fs.writeFileSync(archive, packed.stdout);
        const out = ctx.tmp("out.bin");
        ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), archive, out, flagsFor(fmt)), `apply ${fmt} patch from .${label}`);
        ctx.same(out, ctx.fx("rom/same.bin"), `${fmt} via .${label}`);
      });
    }
    for (const [outLabel, outExt, codecs] of [["zip", "zip", ["store", "deflate", "zstd"]], ["7z", "7z", ["lzma2"]]]) {
      for (const codec of codecs) {
        for (const level of codec === "store" ? ["default"] : ["min", "max"]) {
          add(`apply-matrix.${fmt}.output-${outLabel}-${codec}-${level}`, [...tag, "output", outLabel, codec], (ctx) => {
            const out = ctx.tmp(`out.${outExt}`);
            ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx(patchFx(fmt)), out, ["--compress-format", outLabel, "--compress-codec", codec, ...(codec === "store" ? [] : ["--compress-level", level]), ...flagsFor(fmt)], { compress: true }), `apply ${fmt} -> ${outLabel}/${codec}/${level}`);
            const ex = ctx.tmp("ex");
            ctx.ok(ctx.run(["extract", "--input", out, "--output", ex]), "extract result");
            const files = filesUnder(ex);
            check(files.length === 1, () => `expected one payload, got ${files.map((f) => path.basename(f))}`);
            check(fs.readFileSync(files[0]).equals(fs.readFileSync(ctx.fx("rom/same.bin"))), "payload differs");
            if (outLabel === "7z" && have("7z")) toolMust(toolIn(ctx)("7z", ["t", out]), "7z t");
            if (outLabel === "zip" && codec !== "zstd" && have("unzip")) toolMust(toolIn(ctx)("unzip", ["-tq", out]), "unzip -t");
          });
        }
      }
    }
  }
};
