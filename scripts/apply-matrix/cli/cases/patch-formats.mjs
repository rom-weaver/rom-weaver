// Per-format patch apply battery (one table row per registered patch format).
import fs from "node:fs";
import { add, check, fail, skip } from "../lib/harness.mjs";
import { BSP_FAILURE_VECTORS, BSP_VECTORS } from "../lib/fixture-defs.mjs";

const STRICT_MESSAGE = /checksum|mismatch|invalid|expected|not match|input/i;

/**
 * variants: [name, patchFixture, targetRom, extra args, sourceFixture (default rom/base.bin)]
 * sourceCheck: 'strict' => a wrong source ROM must be rejected; 'lenient' => the format has no source check.
 */
const rw = (kind, format) => [`rw-${kind}`, `patches/rw/${kind}.${format}`, kind];
const ind = (kind, ext, label = kind) => [`ind-${label}`, `patches/ind/${kind}.${ext}`, kind];
const ignore = ["--ignore-checksum-validation"];

export const FORMATS = [
  { name: "ips", label: "IPS", sourceCheck: "lenient", sniff: true, variants: [ind("same", "ips"), ind("grow", "ips"), ind("shrink", "ips"), ["rle", "patches/ind/rle.ips", "rle"], rw("same", "ips"), rw("grow", "ips"), rw("shrink", "ips")] },
  { name: "ips32", label: "IPS32", sourceCheck: "lenient", sniff: true, variants: [ind("same", "ips32"), ind("grow", "ips32"), rw("same", "ips32"), rw("grow", "ips32")] },
  { name: "solid", label: "SOLID", sourceCheck: "strict", sniff: true, integrity: false, variants: [rw("same", "solid"), rw("grow", "solid"), rw("shrink", "solid")] },
  { name: "bps", label: "BPS", sourceCheck: "strict", sniff: true, variants: [ind("same", "bps"), ind("grow", "bps"), ind("shrink", "bps"), ["metadata", "patches/ind/meta.bps", "grow"], ["targetcopy", "patches/ind/targetcopy.bps", "same"], rw("same", "bps"), rw("grow", "bps"), rw("shrink", "bps")] },
  { name: "ups", label: "UPS", sourceCheck: "strict", sniff: true, variants: [ind("same", "ups"), ind("grow", "ups"), ind("shrink", "ups"), rw("same", "ups"), rw("grow", "ups"), rw("shrink", "ups")] },
  { name: "vcdiff", label: "VCDIFF", sourceCheck: "lenient", sniff: true, variants: [ind("same", "vcdiff"), ind("grow", "vcdiff"), ind("shrink", "vcdiff"), ["no-run", "patches/ind/norun.vcdiff", "same"], rw("same", "vcdiff"), rw("grow", "vcdiff"), rw("shrink", "vcdiff")] },
  { name: "vcdiff-adler", label: "VCDIFF", sourceCheck: "strict", sizeCheck: false, sniff: true, variants: [["adler", "patches/ind/adler.vcdiff", "same"]] },
  {
    name: "xdelta",
    label: "xdelta",
    sourceCheck: "strict",
    sizeCheck: false, // VCDIFF copies only from the prefix it needs, so trailing source bytes are legal
    sniff: true,
    variants: [
      rw("same", "xdelta"), rw("grow", "xdelta"), rw("shrink", "xdelta"),
      ["secondary-djw", "patches/rw/secondary-djw.xdelta", "same"],
      ["secondary-fgk", "patches/rw/secondary-fgk.xdelta", "same"],
      ["secondary-lzma", "patches/rw/secondary-lzma.xdelta", "same"],
      ["secondary-auto", "patches/rw/secondary-auto.xdelta", "same"],
      ["upstream-djw", "ext:tests/fixtures/vcdiff/secondary-djw.xdelta", "ext:tests/fixtures/vcdiff/secondary-target.bin", [], "ext:tests/fixtures/vcdiff/secondary-source.bin"],
      ["upstream-djw-legacy", "ext:tests/fixtures/vcdiff/secondary-djw-legacy.xdelta", "ext:tests/fixtures/vcdiff/secondary-target.bin", [], "ext:tests/fixtures/vcdiff/secondary-source.bin"],
      ["upstream-fgk-legacy", "ext:tests/fixtures/vcdiff/secondary-fgk-legacy.xdelta", "ext:tests/fixtures/vcdiff/secondary-target.bin", [], "ext:tests/fixtures/vcdiff/secondary-source.bin"],
      ["upstream-lzma-legacy", "ext:tests/fixtures/vcdiff/secondary-lzma-legacy.xdelta", "ext:tests/fixtures/vcdiff/secondary-target.bin", [], "ext:tests/fixtures/vcdiff/secondary-source.bin"],
    ],
  },
  { name: "gdiff", label: "GDIFF", sourceCheck: "lenient", sniff: true, variants: [ind("same", "gdiff"), ind("grow", "gdiff"), ind("shrink", "gdiff"), rw("same", "gdiff"), rw("grow", "gdiff"), rw("shrink", "gdiff")] },
  {
    name: "hdiff",
    label: "HDiffPatch",
    sourceCheck: "lenient",
    sniff: false,
    variants: ["bz2", "lzma", "lzma2", "zlib", "zstd"].map((codec) => [`hdiff13-${codec}`, `ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiff13-${codec}.hdiff`, "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/target.bin", [], "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin"])
      .concat([["hdiffsf20-zstd", "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiffsf20-zstd.hpatchz", "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/target.bin", [], "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin"]]),
  },
  { name: "aps", label: "APS", sourceCheck: "lenient", sniff: true, variants: [ind("same", "aps"), ["rle", "patches/ind/rle.aps", "rle"], rw("same", "aps"), rw("grow", "aps"), rw("shrink", "aps")] },
  { name: "apsgba", label: "APSGBA", sourceCheck: "strict", sniff: true, variants: [rw("same", "apsgba"), rw("grow", "apsgba"), rw("shrink", "apsgba")] },
  { name: "rup", label: "RUP", sourceCheck: "strict", sniff: true, variants: [rw("same", "rup"), rw("grow", "rup"), rw("shrink", "rup")] },
  {
    name: "ppf",
    label: "PPF",
    sourceCheck: "lenient",
    sniff: true,
    variants: [ind("same", "ppf", "v3-same"), ind("grow", "ppf", "v3-grow"), ["v1", "patches/ind/v1.ppf", "same"], ["v2", "patches/ind/v2.ppf", "same"], ["v3-blockcheck", "patches/ind/v3-blockcheck.ppf", "same"], ["v3-undo", "patches/ind/v3-undo.ppf", "same"], rw("same", "ppf"), ["rw-undo", "patches/rw/undo.ppf", "same"]],
  },
  { name: "pat", label: "PAT", sourceCheck: "lenient", sniff: false, variants: [rw("same", "pat")] },
  { name: "ebp", label: "EBP", sourceCheck: "lenient", sniff: false, variants: [rw("same", "ebp"), rw("grow", "ebp")] },
  { name: "bdf", label: "BDF", sourceCheck: "lenient", sniff: true, variants: [rw("same", "bdf"), rw("grow", "bdf"), rw("shrink", "bdf")] },
  { name: "mod", label: "MOD", sourceCheck: "lenient", sniff: false, extra: ignore, variants: [rw("same", "mod"), rw("grow", "mod")] },
  { name: "dps", label: "DPS", sourceCheck: "lenient", sniff: false, variants: [rw("same", "dps"), rw("grow", "dps"), rw("shrink", "dps")] },
];

const patchExt = (fixture) => fixture.replace(/^.*\./, "");
const romPath = (ctx, name) => (name.startsWith("ext:") ? ctx.fx(name) : ctx.fx(`rom/${name}.bin`));

export const registerPatchFormats = () => {
  for (const format of FORMATS) {
    const group = `patch.${format.name}`;
    const [first] = format.variants;
    const extra = format.extra ?? [];
    const sourceOf = (ctx, variant) => (variant[4] ? ctx.fx(variant[4]) : ctx.fx("rom/base.bin"));
    const run = (ctx, variant, out, more = [], opts) => ctx.apply(sourceOf(ctx, variant), ctx.fx(variant[1]), out, [...extra, ...(variant[3] ?? []), ...more], opts);
    const ext = patchExt(first[1]);

    for (const variant of format.variants) {
      add(`${group}.apply.${variant[0]}`, [format.name, "apply"], (ctx) => {
        const out = ctx.tmp("out.bin");
        ctx.ok(run(ctx, variant, out), "apply");
        ctx.same(out, romPath(ctx, variant[2]), "patched output");
      });
    }

    add(`${group}.validate.ok`, [format.name, "validate"], (ctx) => {
      ctx.ok(ctx.run(["patch", "validate", "--input", sourceOf(ctx, first), "--patch", ctx.fx(first[1]), ...extra]), "patch validate");
    });
    add(`${group}.dry-run.no-output`, [format.name, "dry-run"], (ctx) => {
      const out = ctx.tmp("out.bin");
      ctx.ok(run(ctx, first, out, ["--dry-run"]), "dry-run");
      check(!ctx.exists(out), "dry-run created the output file");
    });
    add(`${group}.report.json`, [format.name, "report"], (ctx) => {
      const result = ctx.ok(run(ctx, first, ctx.tmp("out.bin"), ["--json"]), "apply --json");
      const doc = ctx.json(result);
      check(doc.status === "succeeded" || doc.status === "success" || doc.exit_code === 0, () => `unexpected status ${JSON.stringify(doc.status)}`);
      check(JSON.stringify(doc).toLowerCase().includes(format.label.toLowerCase().split("/")[0]), () => `report does not mention format ${format.label}`);
    });
    add(`${group}.report.jsonl`, [format.name, "report"], (ctx) => {
      const result = ctx.ok(run(ctx, first, ctx.tmp("out.bin"), ["--jsonl"]), "apply --jsonl");
      const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      check(lines.length > 0, "no JSONL events");
      check(["succeeded", "success", "completed"].includes(lines.at(-1).status), () => `terminal status ${lines.at(-1).status}`);
    });

    // ---- source handling
    const derive = (ctx, name, make) => ctx.write(name, make(fs.readFileSync(sourceOf(ctx, first))));
    add(`${group}.wrong-source`, [format.name, "negative"], (ctx) => {
      const out = ctx.tmp("out.bin");
      const wrongSource = derive(ctx, "wrong-source.bin", (bytes) => {
        const copy = bytes.slice();
        copy[100] ^= 0xff;
        return copy;
      });
      const wrong = ctx.apply(wrongSource, ctx.fx(first[1]), out, [...extra, ...(first[3] ?? [])]);
      if (format.sourceCheck === "strict") {
        ctx.failed(wrong, { message: STRICT_MESSAGE, what: "wrong source" });
        check(!ctx.exists(out), "failed apply left an output file behind");
        const forced = ctx.apply(wrongSource, ctx.fx(first[1]), ctx.tmp("forced.bin"), [...extra, ...(first[3] ?? []), ...ignore]);
        ctx.ok(forced, "wrong source with --ignore-checksum-validation");
      } else {
        ctx.ok(wrong, "format without a source check applied to a wrong source");
      }
    });
    add(`${group}.wrong-size-source`, [format.name, "negative"], (ctx) => {
      const out = ctx.tmp("out.bin");
      const longer = derive(ctx, "longer-source.bin", (bytes) => Buffer.concat([bytes, Buffer.alloc(16, 7)]));
      const result = ctx.apply(longer, ctx.fx(first[1]), out, [...extra, ...(first[3] ?? [])]);
      if (result.code === 0) {
        if (format.sourceCheck === "strict" && format.sizeCheck !== false) fail("strict format accepted a source of the wrong size");
        return;
      }
      ctx.failed(result, { what: "wrong-size source" });
      check(!ctx.exists(out), "failed apply left an output file behind");
    });
    add(`${group}.expect-in-out`, [format.name, "checksum"], (ctx) => {
      const sourceCrc = ctx.run(["checksum", "--input", sourceOf(ctx, first), "--algo", "crc32"]).stdout.match(/[0-9a-f]{8}/i)?.[0];
      const targetCrc = ctx.run(["checksum", "--input", romPath(ctx, first[2]), "--algo", "crc32"]).stdout.match(/[0-9a-f]{8}/i)?.[0];
      check(sourceCrc && targetCrc, "could not compute crc32 via the checksum command");
      ctx.ok(run(ctx, first, ctx.tmp("a.bin"), ["--expect-in", `crc32=${sourceCrc}`, "--expect-out", `crc32=${targetCrc}`]), "matching expectations");
      const badIn = run(ctx, first, ctx.tmp("b.bin"), ["--expect-in", "crc32=deadbeef"]);
      ctx.failed(badIn, { what: "--expect-in mismatch" });
      check(!ctx.exists(ctx.tmp("b.bin")), "--expect-in failure left an output");
      const badOut = run(ctx, first, ctx.tmp("c.bin"), ["--expect-out", "crc32=deadbeef"]);
      ctx.failed(badOut, { what: "--expect-out mismatch" });
      check(!ctx.exists(ctx.tmp("c.bin")), "--expect-out failure left an output");
    });

    // ---- malformed patch inputs
    const mutate = (ctx, name, make) => {
      const bytes = fs.readFileSync(ctx.fx(first[1]));
      return ctx.write(name, make(bytes));
    };
    const cleanFailure = (ctx, patch, what) => {
      const out = ctx.tmp(`out-${what}.bin`);
      const result = ctx.apply(sourceOf(ctx, first), patch, out, [...extra, ...(first[3] ?? [])]);
      return { result, out };
    };
    const patBug = format.name === "pat" ? { knownBug: "BUG-PAT-LENIENT-PARSE" } : {};
    add(`${group}.bad-patch.empty`, [format.name, "negative"], (ctx) => {
      const patch = ctx.write(`empty.${ext}`, new Uint8Array(0));
      const { result, out } = cleanFailure(ctx, patch, "empty");
      ctx.failed(result, { what: "empty patch" });
      check(!ctx.exists(out), "empty patch left an output file");
    }, patBug);
    add(`${group}.bad-patch.garbage`, [format.name, "negative"], (ctx) => {
      const patch = ctx.write(`garbage.${ext}`, fs.readFileSync(ctx.fx("patches/garbage.bin")));
      const { result, out } = cleanFailure(ctx, patch, "garbage");
      ctx.failed(result, { what: "garbage patch" });
      check(!ctx.exists(out), "garbage patch left an output file");
    });
    for (const [label, cut] of [["minus-1", (bytes) => bytes.length - 1], ["half", (bytes) => bytes.length >> 1], ["header-only", () => 6]]) {
      add(`${group}.bad-patch.truncated-${label}`, [format.name, "negative", "truncated"], (ctx) => {
        const patch = mutate(ctx, `trunc-${label}.${ext}`, (bytes) => bytes.subarray(0, Math.max(0, cut(bytes))));
        const { result, out } = cleanFailure(ctx, patch, label);
        if (format.name === "pat" && label !== "header-only") {
          // Line-oriented format with no footer: a cut on a record boundary is a valid shorter patch.
          check(!result.panic, () => `crash: ${ctx.describe(result)}`);
          return;
        }
        ctx.failed(result, { what: `patch truncated (${label})` });
        check(!ctx.exists(out), "truncated patch left an output file");
      }, label === "header-only" ? patBug : {});
    }
    add(`${group}.bad-patch.corrupt-middle`, [format.name, "negative"], (ctx) => {
      const patch = mutate(ctx, `corrupt.${ext}`, (bytes) => {
        const copy = bytes.slice();
        copy[copy.length >> 1] ^= 0xff;
        return copy;
      });
      const { result, out } = cleanFailure(ctx, patch, "corrupt");
      check(!result.panic, () => `corrupt patch crashed: ${ctx.describe(result)}`);
      if (result.code !== 0) check(!ctx.exists(out), "failed apply left an output file behind");
      else if (format.sourceCheck === "strict" && format.integrity !== false) {
        // A flipped bit may land in unchecked metadata; the result must then still equal the target.
        ctx.same(out, romPath(ctx, first[2]), "output of a patch with a flipped metadata byte");
      }
    });

    // ---- extension / content sniffing
    if (format.sniff) {
      add(`${group}.sniff.unknown-extension`, [format.name, "probe"], (ctx) => {
        const patch = ctx.write("patch.unknownext", fs.readFileSync(ctx.fx(first[1])));
        const out = ctx.tmp("out.bin");
        ctx.ok(ctx.apply(sourceOf(ctx, first), patch, out, [...extra, ...(first[3] ?? [])]), "apply with unrecognized patch extension");
        ctx.same(out, romPath(ctx, first[2]), "output");
      });
    }

    // ---- determinism / execution-path parity
    add(`${group}.parity.streaming-vs-memory`, [format.name, "determinism"], (ctx) => {
      const memory = ctx.tmp("mem.bin");
      const streaming = ctx.tmp("stream.bin");
      ctx.ok(run(ctx, first, memory), "in-memory apply");
      ctx.ok(run(ctx, first, streaming, [], { env: { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "0" } }), "streaming apply");
      ctx.same(streaming, memory, "streaming output vs in-memory output");
    });
    add(`${group}.parity.threads-and-repeat`, [format.name, "determinism"], (ctx) => {
      const outputs = [];
      for (const [label, threads] of [["t1", "1"], ["t1b", "1"], ["t4", "4"], ["t16", "16"]]) {
        const out = ctx.tmp(`${label}.bin`);
        ctx.ok(run(ctx, first, out, ["--threads", threads]), `apply -j ${threads}`);
        outputs.push(out);
      }
      for (const out of outputs.slice(1)) ctx.same(out, outputs[0], `${out.split("/").pop()} vs t1`);
    });
    add(`${group}.output.overwrite-policy`, [format.name, "output"], (ctx) => {
      const out = ctx.write("existing.bin", "precious");
      const result = run(ctx, first, out);
      ctx.failed(result, { what: "apply over existing output without --force" });
      check(fs.readFileSync(out, "utf8") === "precious", "existing output modified despite refusing");
      ctx.ok(run(ctx, first, out, ["--force"]), "apply --force");
      ctx.same(out, romPath(ctx, first[2]), "forced output");
    });
  }

  // ---- BSP (script patches) -----------------------------------------------------------
  for (const [name] of BSP_FAILURE_VECTORS) {
    add(`patch.bsp.apply.${name}-script-failure`, ["bsp", "negative"], (ctx) => {
      const out = ctx.tmp("out.bin");
      const result = ctx.apply(ctx.fx(`patches/bsp/${name}.in`), ctx.fx(`patches/bsp/${name}.bsp`), out);
      ctx.failed(result, { message: /BSP patch script exited with failure status 1/, what: "BSP failure exit" });
      check(!ctx.exists(out), "failed BSP apply left an output file");
    });
  }
  for (const [name] of BSP_VECTORS) {
    add(`patch.bsp.apply.${name}`, ["bsp", "apply"], (ctx) => {
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(ctx.fx(`patches/bsp/${name}.in`), ctx.fx(`patches/bsp/${name}.bsp`), out), "bsp apply");
      ctx.same(out, ctx.fx(`patches/bsp/${name}.out`), "bsp output");
    });
    add(`patch.bsp.parity.${name}`, ["bsp", "determinism"], (ctx) => {
      const a = ctx.tmp("a.bin");
      const b = ctx.tmp("b.bin");
      ctx.ok(ctx.apply(ctx.fx(`patches/bsp/${name}.in`), ctx.fx(`patches/bsp/${name}.bsp`), a, ["--threads", "1"]), "bsp -j1");
      ctx.ok(ctx.apply(ctx.fx(`patches/bsp/${name}.in`), ctx.fx(`patches/bsp/${name}.bsp`), b, ["--threads", "8"]), "bsp -j8");
      ctx.same(a, b, "bsp -j8 vs -j1");
    });
  }
  add("patch.bsp.bad-patch.menu-unsupported", ["bsp", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("patches/bsp/noop-exit.in"), ctx.fx("patches/bsp/menu.bsp"), out);
    ctx.failed(result, { message: /menu/i, what: "interactive BSP menu" });
    check(!ctx.exists(out), "menu BSP left an output file");
  });
  add("patch.bsp.bad-patch.empty", ["bsp", "negative"], (ctx) => {
    const result = ctx.apply(ctx.fx("patches/bsp/noop-exit.in"), ctx.write("empty.bsp", new Uint8Array(0)), ctx.tmp("out.bin"));
    ctx.failed(result, { what: "empty bsp" });
  });

  // ---- DLDI -------------------------------------------------------------------------------
  add("patch.dldi.apply.driver", ["dldi", "apply"], (ctx) => {
    const out = ctx.tmp("out.nds");
    ctx.ok(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.fx("dldi/driver.dldi"), out), "dldi apply");
    const before = fs.readFileSync(ctx.fx("dldi/slot.nds"));
    const after = fs.readFileSync(out);
    check(after.length === before.length, "DLDI apply changed the file size");
    check(!after.equals(before), "DLDI apply did not modify the slot");
    check(after.subarray(0, 0x300).equals(before.subarray(0, 0x300)), "bytes before the DLDI slot changed");
    check(Buffer.from(after.subarray(0x300 + 0x10, 0x300 + 0x20)).toString("latin1").startsWith("Matrix driver"), "driver name not installed");
  });
  add("patch.dldi.parity.threads-and-streaming", ["dldi", "determinism"], (ctx) => {
    const a = ctx.tmp("a.nds");
    const b = ctx.tmp("b.nds");
    const c = ctx.tmp("c.nds");
    ctx.ok(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.fx("dldi/driver.dldi"), a, ["-j", "1"]), "dldi -j1");
    ctx.ok(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.fx("dldi/driver.dldi"), b, ["-j", "8"]), "dldi -j8");
    ctx.ok(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.fx("dldi/driver.dldi"), c, [], { env: { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "0" } }), "dldi streaming");
    ctx.same(b, a, "dldi -j8 vs -j1");
    ctx.same(c, a, "dldi streaming vs memory");
  });
  add("patch.dldi.apply.oversized-driver", ["dldi", "negative"], (ctx) => {
    const out = ctx.tmp("out.nds");
    const result = ctx.apply(ctx.fx("dldi/slot.nds"), ctx.fx("dldi/oversized.dldi"), out);
    check(!result.panic, () => `crash: ${ctx.describe(result)}`);
    check(result.code === 0 || result.code === 1 || result.code === 2, () => ctx.describe(result));
  });
  add("patch.dldi.apply.no-slot", ["dldi", "negative"], (ctx) => {
    const out = ctx.tmp("out.nds");
    const result = ctx.apply(ctx.fx("dldi/nonslot.nds"), ctx.fx("dldi/driver.dldi"), out);
    ctx.failed(result, { message: /dldi/i, what: "DLDI on a file without a slot" });
    check(!ctx.exists(out), "failed DLDI apply left an output file");
  });
  add("patch.dldi.bad-patch.empty-and-truncated", ["dldi", "negative"], (ctx) => {
    ctx.failed(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.write("e.dldi", new Uint8Array(0)), ctx.tmp("o1.nds")), { what: "empty dldi" });
    const driver = fs.readFileSync(ctx.fx("dldi/driver.dldi"));
    ctx.failed(ctx.apply(ctx.fx("dldi/slot.nds"), ctx.write("t.dldi", driver.subarray(0, 0x30)), ctx.tmp("o2.nds")), { what: "truncated dldi" });
  });

  // ---- recognized-but-unsupported formats -------------------------------------------------------
  add("patch.ninja1.apply.recognized-unsupported", ["ninja1", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/ninja1.rnp"), out);
    ctx.failed(result, { what: "NINJA1" });
    check(!ctx.exists(out), "NINJA1 left an output file");
  });
  add("patch.hdiff.apply.hdiff19-directory-unsupported", ["hdiff", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/hdiff19.hdiff"), out);
    ctx.failed(result, { message: /HDIFF19|directory/i, what: "HDIFF19" });
    check(!ctx.exists(out), "HDIFF19 left an output file");
  });
  add("patch.dcp.apply.positive-rebuild", ["dcp", "apply"], () => {
    skip("DCP needs a GD-ROM data track (ISO9660 + MODE1 EDC/ECC authoring); covered by Rust tests patch_apply_dcp_* in patch_disc.rs");
  });
  add("patch.dcp.apply.requires-disc-sheet", ["dcp", "negative"], (ctx) => {
    const zipPath = ctx.tmp("update.dcp");
    ctx.ok(ctx.run(["compress", "--input", ctx.fx("rom/same.bin"), "--format", "zip", "--output", zipPath]), "build a zip as .dcp");
    const result = ctx.apply(ctx.fx("rom/base.bin"), zipPath, ctx.tmp("out.bin"));
    ctx.failed(result, { message: /cue|gdi|sheet|dcp|dreamcast/i, what: "DCP on a plain ROM" });
  });
  add("patch.pds.apply.unsupported", ["pds", "negative"], (ctx) => {
    const result = ctx.apply(ctx.fx("rom/base.bin"), ctx.write("update.pds", fs.readFileSync(ctx.fx("patches/garbage.bin"))), ctx.tmp("out.bin"));
    ctx.failed(result, { what: "PDS (unregistered format)" });
  });
};
