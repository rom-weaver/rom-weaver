// `rom-weaver trim`: every trim-capable family (NDS/DSi, GBA, 3DS, XISO; GC/Wii discs are refused), round trips with and without a
// revert marker, in-place / dry-run / output-naming policy, folders and archives, and untrimmable / broken inputs.
import fs from "node:fs";
import path from "node:path";
import { add, check, skip } from "../lib/harness.mjs";
import { filesUnder, needTool, toolIn, toolMust } from "../lib/reference-tools.mjs";

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};

// id, fixture, extension, trimmed size, fill byte of the fixture padding
const KINDS = [
  { id: "nds-ds", fx: "exh/nds/ds.nds", ext: "nds", size: 0x30000, pad: 0xff },
  { id: "nds-ds-zero-pad", fx: "exh/nds/ds-zero-pad.nds", ext: "nds", size: 0x30000, pad: 0x00 },
  { id: "nds-dsi", fx: "exh/nds/dsi.nds", ext: "nds", size: 0x40000, pad: 0xff },
  { id: "nds-download-play-cert", fx: "exh/nds/cert.nds", ext: "nds", size: 0x30088, pad: 0xff },
  { id: "gba-ff", fx: "exh/gba/ff.gba", ext: "gba", size: 0x30123, pad: 0xff },
  { id: "gba-zero", fx: "exh/gba/zero.gba", ext: "gba", size: 0x30123, pad: 0x00 },
  { id: "3ds-ncsd", fx: "exh/ctr/game.3ds", ext: "3ds", size: 0x24000, pad: 0xff },
  { id: "3ds-ncsd-zero-pad", fx: "exh/ctr/zero-pad.3ds", ext: "3ds", size: 0x24000, pad: 0x00 },
];
const FOOTER_MIN = 4; // a revert footer is non-empty; exact length is an implementation detail

const stage = (ctx, kind, name = `game.${kind.ext}`) => ctx.write(name, fs.readFileSync(ctx.fx(kind.fx)));
const report = (ctx, args) => {
  const result = ctx.ok(ctx.run(["trim", ...args, "--json"]), `trim ${args.join(" ")}`);
  return ctx.json(result);
};

export const register = () => {
  for (const kind of KINDS) {
    const tag = ["trim", kind.id];
    add(`trim.${kind.id}.default-output-is-new-file`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const original = fs.readFileSync(src);
      ctx.ok(ctx.run(["trim", src]), "trim");
      const made = fs.readdirSync(ctx.work).filter((n) => n !== path.basename(src));
      check(made.length === 1, () => `expected exactly one new file, got ${made.join(",")}`);
      const trimmed = fs.readFileSync(path.join(ctx.work, made[0]));
      check(trimmed.length === kind.size, () => `trimmed size ${trimmed.length}, expected ${kind.size}`);
      check(trimmed.equals(original.subarray(0, kind.size)), "trimmed bytes are not a prefix of the original");
      check(fs.readFileSync(src).equals(original), "source was modified");
    });
    add(`trim.${kind.id}.explicit-output`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const out = ctx.tmp(`out/t.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "-o", out]), "trim -o");
      check(fs.statSync(out).size === kind.size, () => `size ${fs.statSync(out).size}`);
    });
    add(`trim.${kind.id}.in-place`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const original = fs.readFileSync(src);
      ctx.ok(ctx.run(["trim", src, "--in-place"]), "trim --in-place");
      const trimmed = fs.readFileSync(src);
      check(trimmed.length === kind.size && trimmed.equals(original.subarray(0, kind.size)), "in-place trim result wrong");
      check(fs.readdirSync(ctx.work).length === 1, () => `stray files: ${fs.readdirSync(ctx.work).join(",")}`);
    });
    add(`trim.${kind.id}.dry-run-changes-nothing`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const before = fs.readFileSync(src);
      const doc = report(ctx, [src, "--dry-run"]);
      check(doc.details?.dry_run === true && doc.details.would_change === 1, () => `dry-run doc: ${JSON.stringify(doc.details)}`);
      check(fs.readFileSync(src).equals(before) && fs.readdirSync(ctx.work).length === 1, "dry-run changed the filesystem");
      const inPlace = report(ctx, [src, "--dry-run", "--in-place"]);
      check(inPlace.details.dry_run === true, "in-place dry-run doc");
      check(fs.readFileSync(src).equals(before), "in-place dry-run modified the file");
      const reported = doc.label.match(/trimmed_size=(\d+)/);
      if (reported) check(Number(reported[1]) === kind.size, () => `dry-run predicts ${reported[1]}, real size is ${kind.size}`);
    });
    add(`trim.${kind.id}.revert-marker-roundtrip-is-exact`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const original = fs.readFileSync(src);
      const marked = ctx.tmp(`m/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "--revert-marker", "-o", marked]), "trim --revert-marker");
      const markedSize = fs.statSync(marked).size;
      check(markedSize > kind.size + FOOTER_MIN - 1, () => `marker footer missing (size ${markedSize})`);
      const reverted = ctx.tmp(`r/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", marked, "--revert", "-o", reverted]), "trim --revert");
      ctx.same(reverted, src, "marker round trip");
      // aliases
      for (const alias of ["--untrim", "--restore"]) {
        const viaAlias = ctx.tmp(`a${alias}/g.${kind.ext}`);
        ctx.ok(ctx.run(["trim", marked, alias, "-o", viaAlias]), `trim ${alias}`);
        ctx.same(viaAlias, src, `${alias} round trip`);
      }
      const rev2 = ctx.tmp(`r2/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "--reversible", "-o", rev2]), "--reversible alias");
      check(fs.readFileSync(rev2).equals(fs.readFileSync(marked)), "--reversible differs from --revert-marker");
      check(original.length > 0, "fixture");
    });
    add(`trim.${kind.id}.in-place-marker-roundtrip-is-exact`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const original = fs.readFileSync(src);
      ctx.ok(ctx.run(["trim", src, "--in-place", "--revert-marker"]), "trim in-place marker");
      check(fs.statSync(src).size > kind.size, "marker footer missing after in-place trim");
      ctx.ok(ctx.run(["trim", src, "--in-place", "--revert"]), "revert in-place");
      check(fs.readFileSync(src).equals(original), "in-place marker round trip is not byte-exact");
    });
    add(`trim.${kind.id}.revert-without-marker-pads-to-power-of-two`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const original = fs.readFileSync(src);
      const trimmed = ctx.tmp(`t/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "-o", trimmed]), "trim");
      const back = ctx.tmp(`b/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", trimmed, "--revert", "-o", back]), "revert (no marker)");
      const data = fs.readFileSync(back);
      check(data.length === nextPow2(kind.size), () => `reverted size ${data.length}, expected next power of two ${nextPow2(kind.size)}`);
      check(data.subarray(0, kind.size).equals(original.subarray(0, kind.size)), "reverted file lost the data");
      check(data.subarray(kind.size).every((b) => b === 0xff), "unmarked revert pad is not 0xFF");
    });
    add(`trim.${kind.id}.trim-twice-is-idempotent`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const once = ctx.tmp(`1/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "-o", once]), "first trim");
      const doc = report(ctx, [once, "-o", ctx.tmp(`2/g.${kind.ext}`)]);
      check(doc.label.includes("already") || doc.details.already_target >= 0, "no already-trimmed report");
      const twice = ctx.tmp(`2/g.${kind.ext}`);
      if (ctx.exists(twice)) ctx.same(twice, once, "second trim changed the trimmed file");
      const inPlace = ctx.write(`3/g.${kind.ext}`, fs.readFileSync(once));
      ctx.ok(ctx.run(["trim", inPlace, "--in-place"]), "in-place trim of a trimmed file");
      check(fs.readFileSync(inPlace).equals(fs.readFileSync(once)), "in-place retrim changed the file");
    });
    add(`trim.${kind.id}.marker-trimmed-file-trims-again-without-growing`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const marked = ctx.tmp(`m/g.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src, "--revert-marker", "-o", marked]), "marker trim");
      const again = ctx.tmp(`n/g.${kind.ext}`);
      const result = ctx.run(["trim", marked, "-o", again]);
      check(!result.panic && !result.timedOut, () => `retrim of a marked file: ${ctx.describe(result)}`);
      if (ctx.exists(again)) check(fs.statSync(again).size <= fs.statSync(marked).size, "re-trim of a marked file grew it");
    });
    add(`trim.${kind.id}.output-exists-needs-force`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const out = ctx.write(`o/g.${kind.ext}`, "precious");
      ctx.failed(ctx.run(["trim", src, "-o", out]), { message: /overwrite|exists|--force/i, what: "trim onto existing" });
      check(fs.readFileSync(out, "utf8") === "precious", "refused trim modified the existing output");
      ctx.ok(ctx.run(["trim", src, "-o", out, "--force"]), "--force");
      check(fs.statSync(out).size === kind.size, "--force output wrong");
    });
    add(`trim.${kind.id}.extension-template`, tag, (ctx) => {
      const src = stage(ctx, kind);
      ctx.ok(ctx.run(["trim", src, "-e", "small.{ext}"]), "trim -e small.{ext}");
      const expected = path.join(ctx.work, `game.small.${kind.ext}`);
      const alt = fs.readdirSync(ctx.work).filter((n) => n !== path.basename(src));
      check(alt.length === 1, () => `expected one new file, got ${alt.join(",")}`);
      if (!ctx.exists(expected)) ctx.note(`-e small.{ext} produced ${alt[0]}`);
      ctx.ok(ctx.run(["trim", src, "-e", "tiny"]), "trim -e tiny");
    });
    add(`trim.${kind.id}.stdout`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const result = ctx.run(["trim", src, "-o", "-"]);
      ctx.ok(result, "trim -o -");
      check(result.stdoutBytes.length === kind.size, () => `stdout carried ${result.stdoutBytes.length} bytes, expected ${kind.size}`);
      check(fs.readdirSync(ctx.work).length === 1, "stdout trim left files behind");
    });
    add(`trim.${kind.id}.json-jsonl-threads`, tag, (ctx) => {
      const src = stage(ctx, kind);
      const doc = report(ctx, [src, "-o", ctx.tmp(`j/g.${kind.ext}`), "-j", "4"]);
      check(doc.command === "trim" && doc.status === "succeeded", () => JSON.stringify(doc).slice(0, 200));
      const lines = ctx.ok(ctx.run(["trim", src, "-o", ctx.tmp(`jl/g.${kind.ext}`), "--jsonl"]), "trim --jsonl").stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) JSON.parse(line);
      for (const j of ["1", "auto"]) ctx.ok(ctx.run(["trim", src, "-o", ctx.tmp(`jj${j}/g.${kind.ext}`), "-j", j]), `-j ${j}`);
      ctx.same(ctx.tmp("jj1/g." + kind.ext), ctx.tmp(`jjauto/g.${kind.ext}`), "-j parity");
    });
    add(`trim.${kind.id}.unicode-and-space-names`, tag, (ctx) => {
      const src = stage(ctx, kind, `my gämé ☃.${kind.ext}`);
      ctx.ok(ctx.run(["trim", src]), "trim unicode");
      const made = fs.readdirSync(ctx.work).filter((n) => n !== path.basename(src));
      check(made.length === 1 && fs.statSync(path.join(ctx.work, made[0])).size === kind.size, () => `unicode result: ${made.join(",")}`);
    });
    add(`trim.${kind.id}.stdin-is-rejected-or-works`, tag, (ctx) => {
      const result = ctx.run(["trim", "-i", "-"], { input: fs.readFileSync(ctx.fx(kind.fx)) });
      check(!result.panic && !result.timedOut, () => `stdin trim: ${ctx.describe(result)}`);
    });
    add(`trim.${kind.id}.in-zip-archive`, [...tag, "container"], (ctx) => {
      const zip = ctx.tmp("in.zip");
      ctx.ok(ctx.run(["compress", ctx.fx(kind.fx), "-o", zip]), "build zip fixture");
      const before = fs.readFileSync(zip);
      const result = ctx.run(["trim", zip]);
      ctx.ok(result, "trim archive input");
      check(fs.readFileSync(zip).equals(before), "non-in-place trim modified the archive");
      const made = fs.readdirSync(ctx.work).filter((n) => n !== "in.zip");
      check(made.length >= 1, "trim of an archive wrote nothing");
      const out = path.join(ctx.work, made[0]);
      const files = fs.statSync(out).isDirectory() ? fs.readdirSync(out) : [made[0]];
      ctx.note(`trim of zip -> ${made.join(",")} (${files.join(",")})`);
    });
  }

  // ------------------------------------------------------------------ archives repacked in place
  for (const [label, tool, args] of [["zip", "zip", ["-q"]], ["7z", "7z", ["a", "-t7z", "-bso0"]]]) {
    for (const kind of KINDS.filter((k) => ["nds-ds", "gba-ff", "3ds-ncsd"].includes(k.id))) {
      add(`trim.${kind.id}.in-place-in-${label}-marker-roundtrip`, ["trim", kind.id, "container", label], (ctx) => {
        needTool(tool);
        const rom = stage(ctx, kind, `stage/game.${kind.ext}`);
        const archive = ctx.tmp(`g.${label}`);
        toolMust(toolIn(ctx)(tool, [...args, archive, `game.${kind.ext}`], { cwd: path.join(ctx.work, "stage") }), `${tool} build`);
        const original = fs.readFileSync(rom);
        ctx.ok(ctx.run(["trim", archive, "--in-place", "--revert-marker"]), `trim ${label} in place with marker`);
        const ex1 = ctx.tmp("ex1");
        ctx.ok(ctx.run(["extract", archive, "-o", ex1, "--no-ignore"]), "extract trimmed archive");
        const trimmed = filesUnder(ex1);
        check(trimmed.length === 1 && fs.statSync(trimmed[0]).size > kind.size && fs.statSync(trimmed[0]).size < original.length, () => `trimmed member sizes: ${trimmed.map((f) => fs.statSync(f).size)}`);
        ctx.ok(ctx.run(["trim", archive, "--in-place", "--revert"]), `revert ${label} in place`);
        const ex2 = ctx.tmp("ex2");
        ctx.ok(ctx.run(["extract", archive, "-o", ex2, "--no-ignore"]), "extract reverted archive");
        const back = filesUnder(ex2);
        check(back.length === 1 && fs.readFileSync(back[0]).equals(original), "ROM in the reverted archive differs from the original");
        check(fs.readdirSync(ctx.work).filter((n) => !["ex1", "ex2", "stage", "tool-home"].includes(n)).join() === `g.${label}`, () => `stray files: ${fs.readdirSync(ctx.work)}`);
      });
    }
  }
  add("trim.archive.in-place-unsupported-formats-leave-input-untouched", ["trim", "container", "negative"], (ctx) => {
    needTool("tar");
    stage(ctx, KINDS[0], "stage/game.nds");
    toolMust(toolIn(ctx)("tar", ["-czf", ctx.tmp("a.tar.gz"), "game.nds"], { cwd: path.join(ctx.work, "stage") }), "tar");
    const before = fs.readFileSync(ctx.tmp("a.tar.gz"));
    ctx.failed(ctx.run(["trim", ctx.tmp("a.tar.gz"), "--in-place"]), { message: /in-place|cannot be recreated/i, what: "tar.gz in place" });
    check(fs.readFileSync(ctx.tmp("a.tar.gz")).equals(before), "failed run modified the archive");
  });

  // ------------------------------------------------------------------ not trimmable / broken inputs
  add("trim.nds.untrimmable-already-at-boundary", ["trim", "nds"], (ctx) => {
    const src = ctx.write("g.nds", fs.readFileSync(ctx.fx("exh/nds/untrimmable.nds")));
    const doc = report(ctx, [src, "-o", ctx.tmp("o/g.nds")]);
    check(/already/i.test(doc.label), () => `expected an already-trimmed report, got: ${doc.label}`);
    const inPlace = report(ctx, [src, "--in-place"]);
    check(fs.statSync(src).size === 0x30000, "in-place trim changed an already trimmed file");
    check(inPlace.status === "succeeded", "status");
  });
  add("trim.nds.bad-header-crc-rejected", ["trim", "nds", "negative"], (ctx) => {
    const src = ctx.write("g.nds", fs.readFileSync(ctx.fx("exh/nds/bad-crc.nds")));
    const before = fs.readFileSync(src);
    ctx.failed(ctx.run(["trim", src, "--in-place"]), { message: /CRC/i, what: "bad CRC" });
    check(fs.readFileSync(src).equals(before), "failed in-place trim modified the input");
  });
  add("trim.nds.shorter-than-header-rejected", ["trim", "nds", "negative"], (ctx) => {
    const src = ctx.write("g.nds", fs.readFileSync(ctx.fx("exh/nds/short.nds")));
    ctx.failed(ctx.run(["trim", src]), { message: /small|header/i, what: "short nds" });
  });
  add("trim.nds.truncated-below-boundary-rejected", ["trim", "nds", "negative"], (ctx) => {
    const src = ctx.write("g.nds", fs.readFileSync(ctx.fx("exh/nds/ds.nds")).subarray(0, 0x20000));
    ctx.failed(ctx.run(["trim", src, "-o", ctx.tmp("o/g.nds")]), { message: /exceeds|trim|boundary/i, what: "cut-off NDS" });
    ctx.failed(ctx.run(["trim", src, "--in-place"]), { what: "cut-off NDS in place" });
    check(fs.statSync(src).size === 0x20000, "failed in-place trim resized the file");
  });
  add("trim.3ds.not-a-3ds-rejected", ["trim", "3ds", "negative"], (ctx) => {
    const src = ctx.write("g.3ds", fs.readFileSync(ctx.fx("exh/ctr/not-3ds.3ds")));
    ctx.failed(ctx.run(["trim", src, "--in-place"]), { what: "garbage .3ds" });
    check(fs.statSync(src).size === 0x30000, "garbage .3ds was resized");
  });
  add("trim.3ds.cxi-and-cci-extension-support", ["trim", "3ds"], (ctx) => {
    for (const name of ["exh/ctr/game.cci", "exh/ctr/game.cxi"]) {
      const src = ctx.write(path.basename(name), fs.readFileSync(ctx.fx(name)));
      const result = ctx.run(["trim", src, "-o", ctx.tmp(`o-${path.basename(name)}`)]);
      check(!result.panic, `panic on ${name}`);
      ctx.note(`trim ${path.basename(name)} -> exit ${result.code}: ${result.all.trim().split("\n")[0].slice(0, 120)}`);
    }
  });
  add("trim.gba.fully-used-rom-is-untouched", ["trim", "gba"], (ctx) => {
    const src = ctx.write("g.gba", fs.readFileSync(ctx.fx("exh/gba/full.gba")));
    const out = ctx.tmp("o/g.gba");
    ctx.ok(ctx.run(["trim", src, "-o", out]), "trim full GBA");
    if (ctx.exists(out)) ctx.same(out, src, "full GBA trim output");
    ctx.ok(ctx.run(["trim", src, "--in-place"]), "in place");
    ctx.same(src, ctx.fx("exh/gba/full.gba"), "in-place trim of a full ROM changed it");
  });
  add("trim.gba.revert-marker-on-already-trimmed", ["trim", "gba"], (ctx) => {
    const src = ctx.write("g.gba", fs.readFileSync(ctx.fx("exh/gba/ff.gba")).subarray(0, 0x30123));
    const out = ctx.tmp("o/g.gba");
    const result = ctx.run(["trim", src, "--revert-marker", "-o", out]);
    check(!result.panic, "panic");
    if (result.code === 0 && ctx.exists(out)) {
      const back = ctx.tmp("b/g.gba");
      ctx.ok(ctx.run(["trim", out, "--revert", "-o", back]), "revert");
      // An already-trimmed ROM gets no footer (nothing was cut), so revert falls back to the power-of-two guess.
      ctx.note(`--revert-marker on an already trimmed GBA wrote ${fs.statSync(out).size} bytes (no footer); revert gave ${fs.statSync(back).size}`);
    }
  });
  for (const [name, size] of [["zero-byte", 0], ["one-byte", 1], ["header-sized", 0x200], ["nds-header-sized", 0x1000]]) {
    for (const ext of ["nds", "gba", "3ds"]) {
      add(`trim.edge.${name}.${ext}`, ["trim", "edge", ext, "negative"], (ctx) => {
        const src = ctx.write(`g.${ext}`, new Uint8Array(size).fill(0xff));
        const before = fs.readFileSync(src);
        for (const extra of [[], ["--in-place"], ["--revert"], ["--revert", "--in-place"], ["--revert-marker"]]) {
          const result = ctx.run(["trim", src, ...extra, "-j", "1", ...(extra.includes("--in-place") ? [] : ["-o", ctx.tmp(`o${extra.join("")}/g.${ext}`)])]);
          check(!result.panic && !result.timedOut, () => `${extra.join(" ") || "plain"}: ${ctx.describe(result)}`);
        }
        const result = ctx.run(["trim", src, "--in-place"]);
        if (result.code !== 0) check(fs.readFileSync(src).equals(before), "a failed in-place trim modified the input");
      });
    }
  }
  add("trim.edge.all-padding-gba", ["trim", "edge", "gba"], (ctx) => {
    const src = ctx.write("g.gba", new Uint8Array(0x10000).fill(0xff));
    const result = ctx.run(["trim", src, "--in-place"]);
    check(!result.panic, "panic");
    if (result.code === 0) check(fs.statSync(src).size >= 1, "trimmed an all-padding ROM to zero bytes");
  });
  add("trim.unsupported.extension-is-skipped", ["trim", "negative"], (ctx) => {
    const src = ctx.write("notes.txt", "hello");
    const result = ctx.run(["trim", src, "--json"]);
    check(!result.panic, "panic");
    ctx.note(`trim notes.txt -> exit ${result.code}: ${result.all.trim().split("\n")[0].slice(0, 120)}`);
    check(fs.readFileSync(src, "utf8") === "hello" && fs.readdirSync(ctx.work).length === 1, "unsupported input produced output or was modified");
  });
  add("trim.unsupported.nds-content-with-wrong-extension", ["trim", "negative"], (ctx) => {
    const src = ctx.write("game.bin", fs.readFileSync(ctx.fx("exh/nds/ds.nds")));
    const result = ctx.run(["trim", src, "-o", ctx.tmp("o/game.bin")]);
    check(!result.panic, "panic");
    ctx.note(`trim NDS bytes named .bin -> exit ${result.code}: ${result.all.trim().split("\n")[0].slice(0, 120)}`);
  });
  add("trim.input.missing-file", ["trim", "negative"], (ctx) => {
    ctx.failed(ctx.run(["trim", ctx.tmp("nope.nds")]), { what: "missing input" });
  });
  add("trim.input.no-input", ["trim", "negative"], (ctx) => {
    ctx.failed(ctx.run(["trim"]), { what: "no input" });
  });
  add("trim.flags.bad-flags", ["trim", "negative"], (ctx) => {
    const src = ctx.write("g.nds", fs.readFileSync(ctx.fx("exh/nds/ds.nds")));
    ctx.failed(ctx.run(["trim", src, "--bogus"]), { what: "unknown flag" });
    ctx.failed(ctx.run(["trim", src, "-j", "0"]), { what: "-j 0" });
    ctx.failed(ctx.run(["trim", src, "--in-place", "-o", ctx.tmp("x.nds")]), { what: "--in-place with -o" });
    ctx.failed(ctx.run(["trim", src, "--in-place", "-e", "x"]), { what: "--in-place with -e" });
    check(fs.readdirSync(ctx.work).length === 1, () => `bad flags left files: ${fs.readdirSync(ctx.work).join(",")}`);
    ctx.failed(ctx.run(["trim", src, "--revert-marker", "--revert"]), { what: "--revert-marker with --revert" });
  });
  add("trim.flags.output-with-multiple-inputs-rejected", ["trim", "negative"], (ctx) => {
    const a = ctx.write("a.nds", fs.readFileSync(ctx.fx("exh/nds/ds.nds")));
    const b = ctx.write("b.gba", fs.readFileSync(ctx.fx("exh/gba/ff.gba")));
    ctx.failed(ctx.run(["trim", a, b, "-o", ctx.tmp("o/x.nds")]), { what: "-o with two inputs" });
    check(!ctx.exists(ctx.tmp("o/x.nds")), "left an output");
  });
  add("trim.multi.two-files-two-outputs", ["trim"], (ctx) => {
    const a = ctx.write("a.nds", fs.readFileSync(ctx.fx("exh/nds/ds.nds")));
    const b = ctx.write("b.gba", fs.readFileSync(ctx.fx("exh/gba/ff.gba")));
    const doc = report(ctx, [a, b]);
    check(doc.details.processed === 2, () => `processed=${doc.details.processed}`);
    const sizes = fs.readdirSync(ctx.work).filter((n) => !["a.nds", "b.gba"].includes(n)).map((n) => fs.statSync(path.join(ctx.work, n)).size).sort((x, y) => x - y);
    check(sizes.join() === [0x30000, 0x30123].sort((x, y) => x - y).join(), () => `output sizes ${sizes}`);
  });
  add("trim.multi.one-bad-input-does-not-block-others", ["trim", "negative"], (ctx) => {
    const a = ctx.write("a.nds", fs.readFileSync(ctx.fx("exh/nds/bad-crc.nds")));
    const b = ctx.write("b.gba", fs.readFileSync(ctx.fx("exh/gba/ff.gba")));
    const result = ctx.run(["trim", a, b]);
    check(!result.panic, "panic");
    check(result.code !== 0, "a failing input must produce a non-zero exit");
    check(fs.readdirSync(ctx.work).some((n) => n.startsWith("b.") && n !== "b.gba"), "the good input was not trimmed after the bad one failed");
  });

  // ------------------------------------------------------------------ folders
  const folder = (ctx) => {
    ctx.write("lib/a.nds", fs.readFileSync(ctx.fx("exh/nds/ds.nds")));
    ctx.write("lib/sub/b.gba", fs.readFileSync(ctx.fx("exh/gba/ff.gba")));
    ctx.write("lib/sub/deep/c.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    ctx.write("lib/readme.txt", "hi");
    return path.join(ctx.work, "lib");
  };
  add("trim.folder.recursive-by-default", ["trim", "folder"], (ctx) => {
    const dir = folder(ctx);
    const doc = report(ctx, [dir, "--in-place"]);
    check(doc.details.processed === 3, () => `processed=${doc.details.processed}`);
    check(fs.statSync(path.join(dir, "a.nds")).size === 0x30000, "a.nds");
    check(fs.statSync(path.join(dir, "sub/b.gba")).size === 0x30123, "b.gba");
    check(fs.statSync(path.join(dir, "sub/deep/c.3ds")).size === 0x24000, "c.3ds");
    check(fs.readFileSync(path.join(dir, "readme.txt"), "utf8") === "hi", "readme touched");
  });
  add("trim.folder.no-recursive", ["trim", "folder"], (ctx) => {
    const dir = folder(ctx);
    const doc = report(ctx, [dir, "--in-place", "--no-recursive"]);
    check(doc.details.processed === 1, () => `processed=${doc.details.processed}`);
    check(fs.statSync(path.join(dir, "a.nds")).size === 0x30000 && fs.statSync(path.join(dir, "sub/b.gba")).size === 0x100000, "recursion not limited");
  });
  add("trim.folder.not-in-place-leaves-originals", ["trim", "folder"], (ctx) => {
    const dir = folder(ctx);
    ctx.ok(ctx.run(["trim", dir]), "trim folder");
    check(fs.statSync(path.join(dir, "a.nds")).size === 0x80000, "original NDS modified");
    const files = fs.readdirSync(dir, { recursive: true });
    check(files.filter((f) => /trim/.test(f)).length === 3, () => `expected 3 new trimmed files: ${files.join(",")}`);
  });
  add("trim.folder.empty-folder", ["trim", "folder", "negative"], (ctx) => {
    fs.mkdirSync(ctx.tmp("empty"));
    const result = ctx.run(["trim", path.join(ctx.work, "empty")]);
    check(!result.panic, "panic");
    ctx.note(`trim empty folder -> exit ${result.code}`);
  });
  add("trim.folder.symlink-loop-terminates", ["trim", "folder", "negative"], (ctx) => {
    const dir = folder(ctx);
    try {
      fs.symlinkSync(dir, path.join(dir, "loop"));
    } catch {
      // quality-reason: creating symlinks needs privileges some hosts lack; symlink handling is also covered by Rust unit tests in crates/rom-weaver-cli/tests/unit.
      skip("cannot create symlinks");
    }
    const result = ctx.run(["trim", dir, "--in-place"], { timeout: 30000 });
    check(!result.timedOut && !result.panic, () => `symlink loop: ${ctx.describe(result)}`);
  });

  // ------------------------------------------------------------------ GameCube/Wii refusal and XISO
  add("trim.disc.gamecube-wii-discs-are-refused-and-point-to-compress", ["trim", "disc", "negative"], (ctx) => {
    const iso = ctx.fx("reference/gc/disc.iso");
    const gcm = ctx.write("g.gcm", fs.readFileSync(iso));
    const rvz = ctx.write("g.rvz", fs.readFileSync(ctx.fx("disc/made.rvz")));
    for (const [what, input, extra] of [
      ["GameCube .iso", iso, []],
      ["GameCube .gcm", gcm, []],
      ["RVZ", rvz, []],
      ["GameCube .iso --dry-run", iso, ["--dry-run"]],
      ["GameCube .iso --in-place", ctx.write("g.iso", fs.readFileSync(iso)), ["--in-place"]],
      ["GameCube .iso --revert", iso, ["--revert"]],
    ]) {
      ctx.failed(ctx.run(["trim", input, ...extra]), { message: /GameCube\/Wii disc.*rom-weaver compress/s, what });
    }
    const files = fs.readdirSync(ctx.work);
    check(!files.some((name) => /\.trim\./.test(name)), () => `a refused trim left ${files.join(",")}`);
  });
  add("trim.disc.folder-skips-gamecube-wii-discs-as-unsupported", ["trim", "disc"], (ctx) => {
    ctx.write("in/g.iso", fs.readFileSync(ctx.fx("reference/gc/disc.iso")));
    ctx.write("in/g.rvz", fs.readFileSync(ctx.fx("disc/made.rvz")));
    const doc = report(ctx, [path.join(ctx.work, "in")]);
    check(doc.details.processed === 0 && doc.details.skipped_unsupported === 2, () => `details ${JSON.stringify(doc.details)}`);
  });
  add("trim.xiso.trim-keeps-file-contents", ["trim", "xiso"], (ctx) => {
    const src = ctx.write("g.xiso", fs.readFileSync(ctx.fx("disc/xiso.xiso")));
    const out = ctx.tmp("o/g.xiso");
    ctx.ok(ctx.run(["trim", src, "-o", out]), "trim xiso");
    const before = ctx.tmp("ex-before");
    const after = ctx.tmp("ex-after");
    ctx.ok(ctx.run(["extract", src, "-o", before]), "extract original");
    ctx.ok(ctx.run(["extract", out, "-o", after]), "extract trimmed");
    const list = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
    const bf = list(before);
    const af = list(after);
    check(bf.length === af.length && bf.length > 0, () => `file count ${bf.length} vs ${af.length}`);
    for (let i = 0; i < bf.length; i++) check(fs.readFileSync(bf[i]).equals(fs.readFileSync(af[i])), `extracted ${path.basename(bf[i])} differs after trim`);
    ctx.failed(ctx.run(["trim", src, "--revert", "-o", ctx.tmp("r/g.xiso")]), { what: "--revert xiso" });
    ctx.failed(ctx.run(["trim", src, "--revert-marker", "-o", ctx.tmp("m/g.xiso")]), { what: "--revert-marker xiso" });
  });
  add("trim.xiso.padded-image-shrinks", ["trim", "xiso"], (ctx) => {
    // A valid XISO followed by 2 MiB of zero padding: trimming must cut the padding and keep the file system intact.
    const original = fs.readFileSync(ctx.fx("disc/xiso.xiso"));
    const padded = Buffer.concat([original, Buffer.alloc(2 << 20)]);
    const src = ctx.write("pad.xiso", padded);
    const out = ctx.tmp("o/pad.xiso");
    ctx.ok(ctx.run(["trim", src, "-o", out]), "trim padded xiso");
    check(fs.statSync(out).size < padded.length, () => `padded xiso not shrunk (${fs.statSync(out).size} of ${padded.length})`);
    const ex = ctx.tmp("ex");
    ctx.ok(ctx.run(["extract", out, "-o", ex]), "extract trimmed padded xiso");
  });
  add("trim.xiso.dry-run-and-in-place", ["trim", "xiso"], (ctx) => {
    const src = ctx.write("g.xiso", fs.readFileSync(ctx.fx("disc/xiso.xiso")));
    const before = fs.readFileSync(src);
    ctx.ok(ctx.run(["trim", src, "--dry-run", "--in-place"]), "dry-run in-place");
    check(fs.readFileSync(src).equals(before), "dry-run changed the xiso");
    ctx.ok(ctx.run(["trim", src, "--in-place"]), "in-place xiso trim");
    check(fs.readdirSync(ctx.work).length === 1, () => `stray files: ${fs.readdirSync(ctx.work).join(",")}`);
  });
};
