// Cross-format apply features: chains, headers, byte order, checksum flags, validate, weave, PPF undo, cheats.
import fs from "node:fs";
import { add, check, skip } from "../lib/harness.mjs";

const crc32Of = (ctx, file, algo = "crc32") => {
  const result = ctx.ok(ctx.run(["checksum", "--input", file, "--algo", algo]), `checksum ${algo}`);
  const match = result.stdout.match(new RegExp(`${algo}\\s*[:=]?\\s*([0-9a-f]{8,128})`, "i")) ?? result.stdout.match(/([0-9a-f]{8,128})/i);
  check(match, () => `no ${algo} in checksum output: ${result.stdout}`);
  return match[1].toLowerCase();
};

export const register = () => {
  // ------------------------------------------------------------------ chains
  const chain = (ctx) => [ctx.fx("chain/1-base-to-same.ips"), ctx.fx("chain/2-same-to-grow.bps"), ctx.fx("chain/3-grow-to-shrink.ups")];
  const applyChain = (ctx, patches, out, extra = [], env) => ctx.apply(ctx.fx("rom/base.bin"), patches, out, extra, { env });

  add("chain.apply.three-formats-auto", ["chain"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(applyChain(ctx, chain(ctx), out), "chain");
    ctx.same(out, ctx.fx("rom/shrink.bin"), "chain result");
  });
  add("chain.apply.default-basis-previous", ["chain"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(applyChain(ctx, chain(ctx), out, ["--default-patch-basis", "previous"]), "chain previous");
    ctx.same(out, ctx.fx("rom/shrink.bin"), "chain result");
  });
  add("chain.apply.per-patch-basis", ["chain"], (ctx) => {
    const [a, b, c] = chain(ctx);
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--patch", a, "--patch-basis", "base", "--patch", b, "--patch-basis", "previous", "--patch", c, "--patch-basis", "auto", "--output", out, "--no-compress"]), "chain per-patch basis");
    ctx.same(out, ctx.fx("rom/shrink.bin"), "chain result");
  });
  add("chain.apply.wrong-order-fails", ["chain", "negative"], (ctx) => {
    const [a, b, c] = chain(ctx);
    const out = ctx.tmp("out.bin");
    ctx.failed(applyChain(ctx, [b, a, c], out), { what: "reordered chain" });
    check(!ctx.exists(out), "failed chain left an output");
  });
  add("chain.apply.middle-patch-bad-source", ["chain", "negative"], (ctx) => {
    const [a, , c] = chain(ctx);
    const out = ctx.tmp("out.bin");
    ctx.failed(applyChain(ctx, [a, c], out), { what: "chain skipping a step" });
    check(!ctx.exists(out), "failed chain left an output");
  });
  add("chain.apply.base-basis-bps-from-original", ["chain"], (ctx) => {
    // A BPS authored against the original ROM applied alone must equal grow.bin.
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("chain/2b-base-to-grow.bps"), out, ["--default-patch-basis", "base"]), "base-basis apply");
    ctx.same(out, ctx.fx("rom/grow.bin"), "result");
  });
  add("chain.checks.patch-input-output", ["chain", "checksum"], (ctx) => {
    const [a, b, c] = chain(ctx);
    const same = crc32Of(ctx, ctx.fx("rom/same.bin"));
    const grow = crc32Of(ctx, ctx.fx("rom/grow.bin"));
    const base = crc32Of(ctx, ctx.fx("rom/base.bin"));
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--patch", a, "--patch-input-check", `crc32=${base}`, "--patch-output-check", `crc32=${same}`, "--patch", b, "--patch-output-check", `crc32=${grow}`, "--patch", c, "--output", out, "--no-compress"]), "chain with checks");
    ctx.same(out, ctx.fx("rom/shrink.bin"), "chain result");
    const bad = ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--patch", a, "--patch-output-check", "crc32=12345678", "--patch", b, "--output", ctx.tmp("bad.bin"), "--no-compress"]);
    ctx.failed(bad, { what: "wrong --patch-output-check" });
    check(!ctx.exists(ctx.tmp("bad.bin")), "failed check left output");
  });
  add("chain.parity.threads-and-streaming", ["chain", "determinism"], (ctx) => {
    const a = ctx.tmp("a.bin");
    const b = ctx.tmp("b.bin");
    const c = ctx.tmp("c.bin");
    ctx.ok(applyChain(ctx, chain(ctx), a, ["-j", "1"]), "chain -j1");
    ctx.ok(applyChain(ctx, chain(ctx), b, ["-j", "8"]), "chain -j8");
    ctx.ok(applyChain(ctx, chain(ctx), c, [], { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "0" }), "chain streaming");
    ctx.same(b, a, "chain -j8 vs -j1");
    ctx.same(c, a, "chain streaming vs memory");
  });

  // ------------------------------------------------------------ validate command
  add("validate.ok.chain", ["validate"], (ctx) => {
    const args = ["patch", "validate", "--input", ctx.fx("rom/base.bin")];
    for (const patch of chain(ctx)) args.push("--patch", patch);
    ctx.ok(ctx.run(args), "validate chain");
  });
  add("validate.fail.wrong-source", ["validate", "negative"], (ctx) => {
    ctx.failed(ctx.run(["patch", "validate", "--input", ctx.fx("rom/wrong.bin"), "--patch", ctx.fx("patches/ind/same.bps")]), { what: "validate wrong source" });
  });
  add("validate.plan.reports-verdict-exit0", ["validate"], (ctx) => {
    const result = ctx.run(["--json", "patch", "validate", "--plan", "--input", ctx.fx("rom/wrong.bin"), "--patch", ctx.fx("patches/ind/same.bps")]);
    ctx.ok(result, "validate --plan");
    check(/patch_validation/.test(result.stdout), "no details.patch_validation in --plan output");
  });
  add("validate.independent.exit1-on-any-failure", ["validate"], (ctx) => {
    const result = ctx.run(["patch", "validate", "--independent", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.bps"), "--patch", ctx.fx("chain/2-same-to-grow.bps")]);
    ctx.failed(result, { codes: [1], what: "validate --independent with one failing patch" });
  });
  add("validate.expect-in.size-gates", ["validate", "checksum"], (ctx) => {
    const base = ["patch", "validate", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.ips")];
    ctx.ok(ctx.run([...base, "--expect-in", "size=40960"]), "size= match");
    ctx.failed(ctx.run([...base, "--expect-in", "size=40961"]), { what: "size= mismatch" });
    ctx.ok(ctx.run([...base, "--expect-in", "min-size=40000"]), "min-size= ok");
    ctx.failed(ctx.run([...base, "--expect-in", "min-size=50000"]), { what: "min-size= too big" });
  });
  add("validate.leaves-no-output", ["validate"], (ctx) => {
    const before = fs.readdirSync(ctx.work);
    ctx.ok(ctx.run(["patch", "validate", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.bps")]), "validate");
    check(fs.readdirSync(ctx.work).length === before.length, "validate left files in the working directory");
  });

  // ------------------------------------------------------------- checksum flags
  for (const algo of ["crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "adler32"]) {
    add(`checksum-flags.expect-in-out.${algo}`, ["checksum", algo], (ctx) => {
      const input = crc32Of(ctx, ctx.fx("rom/base.bin"), algo);
      const output = crc32Of(ctx, ctx.fx("rom/same.bin"), algo);
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/ind/same.ips"), out, ["--expect-in", `${algo}=${input}`, "--expect-out", `${algo}=${output}`]), `expect ${algo}`);
      ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/ind/same.ips"), ctx.tmp("bad.bin"), ["--expect-out", `${algo}=${"0".repeat(input.length)}`]), { what: `wrong --expect-out ${algo}` });
    });
  }
  add("checksum-flags.assume-in.skips-hashing-but-checks-patch", ["checksum"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const crc = crc32Of(ctx, ctx.fx("rom/base.bin"));
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/ind/same.bps"), out, ["--assume-in", `crc32=${crc}`]), "assume-in");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });
  add("checksum-flags.ignore-validation.corrupt-patch-checksum", ["checksum"], (ctx) => {
    const bytes = Buffer.from(fs.readFileSync(ctx.fx("patches/ind/same.bps")));
    bytes[bytes.length - 1] ^= 0xff; // patch's own crc32 footer
    const patch = ctx.write("badfooter.bps", bytes);
    ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), patch, ctx.tmp("a.bin")), { message: /checksum/i, what: "bad patch footer" });
    const out = ctx.tmp("b.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out, ["--ignore-checksum-validation"]), "bad footer with ignore flag");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });
  add("checksum-flags.ups-reverse-apply-to-target", ["checksum", "ups"], (ctx) => {
    const out = ctx.tmp("out.bin");
    const result = ctx.apply(ctx.fx("rom/same.bin"), ctx.fx("patches/ind/same.ups"), out);
    ctx.ok(result, "UPS applied to the target ROM (UPS is reversible)");
    ctx.same(out, ctx.fx("rom/base.bin"), "reverse-applied output");
  });
  add("checksum-flags.checksum-name-token", ["checksum"], (ctx) => {
    const base = crc32Of(ctx, ctx.fx("rom/base.bin"));
    const named = ctx.write(`same [crc32:${base}].ips`, fs.readFileSync(ctx.fx("patches/ind/same.ips")));
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), named, ctx.tmp("ok.bin")), "token matches");
    const wrongToken = ctx.write("same [crc32:deadbeef].ips", fs.readFileSync(ctx.fx("patches/ind/same.ips")));
    ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), wrongToken, ctx.tmp("bad.bin")), { what: "[crc32:..] token mismatch" });
  });

  // ------------------------------------------------------------------- headers
  const hdr = (ctx, name) => ctx.fx(`hdr/${name}`);
  add("header.snes.auto-strips-for-checksummed-bps", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes.bps"), out), "bps on smc");
    const produced = [out, out.replace(/\.smc$/, ".sfc")].find((file) => ctx.exists(file));
    check(produced, "no output produced");
    ctx.same(produced, hdr(ctx, "snes-patched.sfc"), "headerless output");
  });
  add("header.snes.auto-strips-for-checksumless-ips", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes.ips"), out), "ips on smc");
    const produced = [out, out.replace(/\.smc$/, ".sfc")].find((file) => ctx.exists(file));
    check(produced, "no output produced");
    ctx.same(produced, hdr(ctx, "snes-patched.sfc"), "headerless output");
  });
  add("header.snes.keep-fails-checksummed-bps", ["header", "snes", "negative"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.failed(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes.bps"), out, ["--patch-header", "keep"]), { what: "--patch-header keep with headerless BPS" });
  });
  add("header.snes.strip-then-output-keep-restores-header", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes.bps"), out, ["--patch-header", "strip", "--output-header", "keep"]), "strip + keep");
    ctx.same(out, hdr(ctx, "snes-patched.smc"), "headered output");
  });
  add("header.snes.output-header-strip-on-headerless-input", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.sfc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.sfc"), hdr(ctx, "snes.bps"), out, ["--output-header", "strip"]), "headerless input");
    ctx.same(out, hdr(ctx, "snes-patched.sfc"), "output");
  });
  add("header.snes.headered-patch-keeps-header", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes-hdr.bps"), out, ["--patch-header", "keep", "--output-header", "keep"]), "headered bps");
    ctx.same(out, hdr(ctx, "snes-patched.smc"), "headered output");
  });
  add("header.snes.auto-picks-keep-for-headered-bps", ["header", "snes"], (ctx) => {
    const out = ctx.tmp("out.smc");
    ctx.ok(ctx.apply(hdr(ctx, "snes.smc"), hdr(ctx, "snes-hdr.bps"), out, ["--output-header", "keep"]), "headered bps auto");
    ctx.same(out, hdr(ctx, "snes-patched.smc"), "headered output");
  });
  add("header.nes.header-retained-on-output", ["header", "nes"], (ctx) => {
    const out = ctx.tmp("out.nes");
    ctx.ok(ctx.apply(hdr(ctx, "nes.nes"), hdr(ctx, "nes.bps"), out), "nes bps");
    ctx.same(out, hdr(ctx, "nes-patched.nes"), "iNES output keeps its header");
  });
  add("header.nes.headerless-patch-restores-header", ["header", "nes"], (ctx) => {
    const out = ctx.tmp("out.nes");
    ctx.ok(ctx.apply(hdr(ctx, "nes.nes"), hdr(ctx, "nes-headerless.bps"), out), "headerless nes bps");
    ctx.same(out, hdr(ctx, "nes-patched.nes"), "iNES output");
  });
  add("header.nes.output-header-strip", ["header", "nes"], (ctx) => {
    const out = ctx.tmp("out.nes");
    ctx.ok(ctx.apply(hdr(ctx, "nes.nes"), hdr(ctx, "nes-headerless.bps"), out, ["--output-header", "strip"]), "nes strip");
    const produced = fs.readFileSync(out);
    const expected = fs.readFileSync(hdr(ctx, "nes-patched.nes")).subarray(16);
    check(produced.equals(expected), () => `stripped NES output mismatch (len ${produced.length} vs ${expected.length})`);
  });

  // --------------------------------------------------------------- N64 byte order
  for (const [label, ext] of [["z64", "z64"], ["v64", "v64"], ["n64", "n64"]]) {
    add(`n64.auto-order.input-${label}`, ["n64", "header"], (ctx) => {
      const out = ctx.tmp(`out.${ext}`);
      ctx.ok(ctx.apply(hdr(ctx, `n64.${ext}`), hdr(ctx, "n64.bps"), out), `auto order from ${label}`);
      ctx.same(out, hdr(ctx, `n64-patched.${ext}`), "output is written back in the input order");
    });
  }
  add("n64.keep-fails-for-swapped-input", ["n64", "negative"], (ctx) => {
    ctx.failed(ctx.apply(hdr(ctx, "n64.v64"), hdr(ctx, "n64.bps"), ctx.tmp("out.v64"), ["--n64-byte-order", "keep"]), { what: "--n64-byte-order keep on .v64" });
  });
  // The BPS was authored on the big-endian dump, so only `big-endian` makes it match; the
  // output goes back to the interleaving the input arrived in.
  for (const ext of ["v64", "n64"]) {
    add(`n64.explicit-order.big-endian-from-${ext}`, ["n64", "header"], (ctx) => {
      const out = ctx.tmp(`out.${ext}`);
      ctx.ok(ctx.apply(hdr(ctx, `n64.${ext}`), hdr(ctx, "n64.bps"), out, ["--n64-byte-order", "big-endian"]), "--n64-byte-order big-endian");
      ctx.same(out, hdr(ctx, `n64-patched.${ext}`), "output");
    });
  }
  for (const order of ["little-endian", "byte-swapped"]) {
    add(`n64.explicit-order.${order}-breaks-bps-on-z64`, ["n64", "negative"], (ctx) => {
      ctx.failed(ctx.apply(hdr(ctx, "n64.z64"), hdr(ctx, "n64.bps"), ctx.tmp("out.z64"), ["--n64-byte-order", order]), { what: `--n64-byte-order ${order} on a z64` });
    });
  }

  // ----------------------------------------------------------------- repair checksum
  add("repair-checksum.gb-header-and-global", ["repair"], (ctx) => {
    const out = ctx.tmp("out.gb");
    ctx.ok(ctx.apply(ctx.fx("gb/game.gb"), ctx.fx("gb/edit.ips"), out, ["--repair-checksum"]), "repair-checksum");
    const rom = fs.readFileSync(out);
    let header = 0;
    for (let at = 0x134; at <= 0x14c; at++) header = (header - rom[at] - 1) & 0xff;
    let sum = 0;
    for (let at = 0; at < rom.length; at++) if (at !== 0x14e && at !== 0x14f) sum = (sum + rom[at]) & 0xffff;
    check(rom[0x14d] === header, "GB header checksum not valid");
    check(((rom[0x14e] << 8) | rom[0x14f]) === sum, "GB global checksum not valid");
    const plain = ctx.tmp("plain.gb");
    ctx.ok(ctx.apply(ctx.fx("gb/game.gb"), ctx.fx("gb/edit.ips"), plain), "apply without repair");
    const unrepaired = fs.readFileSync(plain);
    check(!unrepaired.equals(rom), "--repair-checksum changed nothing relative to plain apply");
  });

  // ------------------------------------------------------------------------ PPF undo
  add("ppf-undo.round-trip", ["ppf", "tools"], (ctx) => {
    const source = ctx.write("base.gb", fs.readFileSync(ctx.fx("rom/base.bin")));
    const patched = ctx.tmp("patched.gb");
    ctx.ok(ctx.apply(source, ctx.fx("patches/ind/v3-undo.ppf"), patched), "apply undoable ppf");
    ctx.same(patched, ctx.fx("rom/same.bin"), "patched");
    const restored = ctx.tmp("restored.gb");
    ctx.ok(ctx.run(["tools", "ppf-undo", "--input", patched, "--patch", ctx.fx("patches/ind/v3-undo.ppf"), "--output", restored]), "ppf-undo");
    ctx.same(restored, ctx.fx("rom/base.bin"), "restored ROM");
  });
  add("ppf-undo.requires-undo-data", ["ppf", "tools", "negative"], (ctx) => {
    const input = ctx.write("same.gb", fs.readFileSync(ctx.fx("rom/same.bin")));
    ctx.failed(ctx.run(["tools", "ppf-undo", "--input", input, "--patch", ctx.fx("patches/ind/same.ppf"), "--output", ctx.tmp("restored.gb")]), { message: /undo/i, what: "ppf-undo without undo data" });
  });

  add("ppf-undo.wrong-rom-warns", ["ppf", "tools"], (ctx) => {
    // The restore still runs (a deliberately modified ROM can be undone) but the mismatch is reported.
    const input = ctx.write("never-patched.gb", fs.readFileSync(ctx.fx("rom/base.bin")));
    const restored = ctx.tmp("restored.gb");
    const result = ctx.ok(ctx.run(["tools", "ppf-undo", "--input", input, "--patch", ctx.fx("patches/ind/v3-undo.ppf"), "--output", restored, "--no-compress", "--json"]), "ppf-undo on an unpatched ROM");
    const doc = ctx.json(result);
    check(Array.isArray(doc.warnings) && doc.warnings.some((warning) => /does not match the patched data/.test(warning)), () => `no mismatch warning in ${JSON.stringify(doc.warnings)}`);
    const human = ctx.ok(ctx.run(["tools", "ppf-undo", "--input", input, "--patch", ctx.fx("patches/ind/v3-undo.ppf"), "--output", ctx.tmp("restored-human.gb"), "--no-compress"]), "ppf-undo human output");
    check(/does not match the patched data/.test(human.all), () => `human output hides the warning: ${ctx.describe(human)}`);
  });

  // ------------------------------------------------------------ corrupt / ambiguous patch handling
  add("patch.pat.bad-record-line", ["pat", "negative"], (ctx) => {
    const patch = ctx.write("mixed.pat", "00000000 61 41\n00000001 6g 42\n");
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), patch, out), { message: /PAT patch line 2/, what: "PAT with an unparseable record line" });
    check(!ctx.exists(out), "failed PAT apply left an output file");
  });
  add("patch.pat.comments-and-blank-lines-allowed", ["pat"], (ctx) => {
    const base = fs.readFileSync(ctx.fx("rom/base.bin"));
    const hex = (byte) => byte.toString(16).padStart(2, "0");
    const flipped = base[0] ^ 0xff;
    const patch = ctx.write("commented.pat", `# comment\n\n00000000 ${hex(base[0])} ${hex(flipped)}\n`);
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out), "PAT with comment and blank lines");
    check(fs.readFileSync(out)[0] === flipped, "PAT record was not applied");
  });
  add("patch.ips32.implausible-output-size", ["ips32", "negative"], (ctx) => {
    const bytes = Buffer.concat([Buffer.from("IPS32"), Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0x01, 0x5a]), Buffer.from("EEOF")]);
    const patch = ctx.write("corrupt.ips32", bytes);
    const out = ctx.tmp("out.bin");
    const result = ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), patch, out, ["--json"]), { message: /probably corrupt/, what: "IPS32 with a 4 GiB offset" });
    check(/patch\.output_size_implausible/.test(result.all), () => `missing error code: ${ctx.describe(result)}`);
    check(!ctx.exists(out), "rejected IPS32 apply left an output file");
  });
  add("patch.ebp.sniffed-without-ebp-extension", ["ebp"], (ctx) => {
    const original = fs.readFileSync(ctx.fx("patches/rw/same.ebp"));
    for (const name of ["sniffed.bin", "sniffed.patch", "sniffed.ips"]) {
      const patch = ctx.write(name, original);
      const out = ctx.tmp(`out-${name}`);
      ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out), `EBP patch named ${name}`);
      ctx.same(out, ctx.fx("rom/same.bin"), `output of EBP patch named ${name}`);
    }
  });
  add("diagnostics.select-help-says-folder-not-prefix", ["diagnostics", "select"], (ctx) => {
    for (const args of [["patch", "apply", "--help"], ["extract", "--help"]]) {
      const help = ctx.ok(ctx.run(args), args.join(" ")).stdout;
      check(/exact name, folder, or glob/.test(help), () => `${args.join(" ")} help does not describe folder matching`);
      check(!/prefix, or glob/.test(help), () => `${args.join(" ")} help still says prefix`);
    }
  });

  // ----------------------------------------------------------------- weave integration
  add("weave.create-then-apply", ["weave"], (ctx) => {
    ctx.write("rom.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
    ctx.write("a.bps", fs.readFileSync(ctx.fx("patches/ind/same.bps")));
    ctx.ok(ctx.run(["weave", "create", "--input", "rom.bin", "--patch", "a.bps", "--patch-name", "First", "--output", "w.json"]), "weave create");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.tmp("w.json"), "--output", out, "--no-compress"]), "apply weave");
    ctx.same(out, ctx.fx("rom/same.bin"), "weave result");
  });
  add("weave.apply.rom-mismatch-fails", ["weave", "negative"], (ctx) => {
    ctx.write("rom.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
    ctx.write("a.bps", fs.readFileSync(ctx.fx("patches/ind/same.bps")));
    ctx.ok(ctx.run(["weave", "create", "--input", "rom.bin", "--patch", "a.bps", "--output", "w.json"]), "weave create");
    ctx.write("rom.bin", fs.readFileSync(ctx.fx("rom/wrong.bin")));
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.tmp("w.json"), "--output", out, "--no-compress"]), { what: "weave with a changed ROM" });
    check(!ctx.exists(out), "failed weave apply left output");
  });
  add("weave.emit-weave.matches-weave-create", ["weave"], (ctx) => {
    ctx.write("rom.bin", fs.readFileSync(ctx.fx("rom/base.bin")));
    ctx.write("a.bps", fs.readFileSync(ctx.fx("patches/ind/same.bps")));
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", "rom.bin", "--patch", "a.bps", "--output", out, "--no-compress", "--emit-weave", "emitted.json"]), "apply --emit-weave");
    check(ctx.exists(ctx.tmp("emitted.json")), "no weave emitted");
    const doc = JSON.parse(fs.readFileSync(ctx.tmp("emitted.json"), "utf8"));
    check(doc.patches?.length === 1, "emitted weave lacks the patch");
    const replay = ctx.tmp("replay.bin");
    ctx.ok(ctx.run(["patch", "apply", "--input", ctx.tmp("emitted.json"), "--output", replay, "--no-compress"]), "replay emitted weave");
    ctx.same(replay, out, "replayed weave output");
  });
  add("weave.alias.patch-weave-and-top-level-weave", ["weave"], (ctx) => {
    const a = ctx.tmp("a.bin");
    const b = ctx.tmp("b.bin");
    ctx.ok(ctx.run(["weave", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.bps"), "--output", a, "--no-compress"]), "weave alias");
    ctx.ok(ctx.run(["patch", "weave", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.bps"), "--output", b, "--no-compress"]), "patch weave alias");
    ctx.same(a, ctx.fx("rom/same.bin"), "weave alias output");
    ctx.same(b, ctx.fx("rom/same.bin"), "patch weave alias output");
  });

  // ------------------------------------------------------------------------ cheats (--code)
  const codeCase = (name, rom, code, extraArgs, offset, value, out) =>
    add(`cheats.code.${name}`, ["cheats"], (ctx) => {
      const baked = ctx.tmp(out);
      ctx.ok(ctx.apply(ctx.fx(rom), [], baked, ["--code", code, ...extraArgs]), `--code ${code}`);
      const rom0 = fs.readFileSync(ctx.fx(rom));
      const after = fs.readFileSync(baked);
      check(after[offset] === value, () => `byte @0x${offset.toString(16)} is 0x${after[offset].toString(16)}, expected 0x${value.toString(16)}`);
      check(after.length === rom0.length, "ROM length changed");
      let changed = 0;
      for (let at = 0; at < after.length; at++) if (after[at] !== rom0[at]) changed++;
      check(changed <= 1, () => `${changed} bytes changed for a single-byte code`);
      // The same code expressed as a patch must produce identical bytes.
      const patch = ctx.tmp("code.ips");
      ctx.ok(ctx.run(["patch", "create", "--original", ctx.fx(rom), "--code", code, ...extraArgs, "--output", patch]), "patch create --code");
      const viaPatch = ctx.tmp(`via-patch-${out}`);
      ctx.ok(ctx.apply(ctx.fx(rom), patch, viaPatch), "apply code-derived patch");
      ctx.same(viaPatch, baked, "--code bake vs code-derived patch");
    });
  codeCase("nes-game-genie", "cheats/nes32.nes", "AKE-LVS", [], 0x3d96, 0x48, "out.nes");
  codeCase("snes-game-genie", "cheats/snes4m.sfc", "ABCD-EFFF", ["--code-system", "snes"], 0x222704, 0xc9, "out.sfc");
  codeCase("gb-game-genie", "gb/game.gb", "AB100F", ["--code-system", "gameboy"], 0x100, 0xab, "out.gb");
  add("cheats.code.after-patch-chain", ["cheats", "chain"], (ctx) => {
    const out = ctx.tmp("out.gb");
    ctx.ok(ctx.apply(ctx.fx("gb/game.gb"), ctx.fx("gb/edit.ips"), out, ["--code", "AB100F", "--code-system", "gameboy"]), "patch then code");
    const rom = fs.readFileSync(out);
    check(rom[0x100] === 0xab && rom[0x1000] !== fs.readFileSync(ctx.fx("gb/game.gb"))[0x1000], "code and patch were not both applied");
  });
  add("cheats.code.invalid-code-rejected", ["cheats", "negative"], (ctx) => {
    const out = ctx.tmp("out.gb");
    ctx.failed(ctx.apply(ctx.fx("gb/game.gb"), [], out, ["--code", "NOT-A-CODE!"]), { what: "malformed cheat code" });
    check(!ctx.exists(out), "left an output");
  });
  add("cheats.code.with-patch-header-strip-rejected", ["cheats", "negative"], (ctx) => {
    ctx.failed(ctx.apply(ctx.fx("cheats/nes32.nes"), [], ctx.tmp("o.nes"), ["--code", "AKE-LVS", "--patch-header", "strip"]), { what: "--code with --patch-header strip" });
  });
  add("cheats.database.cheat-flag", ["cheats"], () => {
    skip("--cheat needs the offline cheat database (rom-weaver setup downloads it); a synthetic-shard workflow is covered by Rust tests cheats.rs patch_apply_bakes_database_cheats_and_refuses_unbakeable_ones");
  });
};
