// Large-ROM (streaming/sparse apply tiers), diagnostics flags, and recorded gaps.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { add, check, skip } from "../lib/harness.mjs";
import * as E from "../lib/encoders.mjs";

const LARGE = 34 * 1024 * 1024; // above the 32 MiB sparse-streaming threshold
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const largeSource = () => {
  const block = new Uint8Array(65536);
  let state = 0x1a2b3c4d;
  for (let index = 0; index < block.length; index++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    block[index] = state & 255;
  }
  const out = new Uint8Array(LARGE);
  for (let at = 0; at < LARGE; at += block.length) out.set(block, at);
  return out;
};
const largeTarget = (source) => {
  const out = source.slice();
  out.fill(0xee, 0, 64);
  out.fill(0x11, LARGE >> 1, (LARGE >> 1) + 5000);
  for (let at = LARGE - 4096; at < LARGE; at += 7) out[at] ^= 0xff;
  return out;
};

export const register = ({ fixtures }) => {
  fixtures.define("large/source.bin", { where: "cache", purpose: "34 MiB repeating-block ROM (crosses the 32 MiB sparse-streaming apply threshold)", how: "lib/../cases/misc.mjs largeSource()", deterministic: true, build: () => largeSource() });
  fixtures.define("large/target.bin", { where: "cache", purpose: "large source with sparse edits at start/middle/end", how: "largeTarget()", deterministic: true, build: () => largeTarget(largeSource()) });
  const sparse = (name, purpose, build) => fixtures.define(`large/${name}`, { where: "cache", purpose, how: "independent encoder in lib/encoders.mjs", deterministic: true, build });
  const src = () => fixtures.bytes("large/source.bin");
  const tgt = () => fixtures.bytes("large/target.bin");
  sparse("sparse.ips32", "IPS32 for the large ROM", () => E.encodeIps32(src(), tgt()));
  sparse("sparse.ppf", "PPF3 for the large ROM", () => E.encodePpf3(src(), tgt()));
  sparse("sparse.bps", "BPS for the large ROM", () => E.encodeBps(src(), tgt()));
  sparse("sparse.ups", "UPS for the large ROM", () => E.encodeUps(src(), tgt()));
  sparse("sparse.gdiff", "GDIFF for the large ROM", () => E.encodeGdiff(src(), tgt()));
  sparse("sparse.vcdiff", "VCDIFF for the large ROM", () => E.encodeVcdiff(src(), tgt(), { adler: true }));

  // IPS is omitted: its 3-byte offsets cannot address edits beyond 16 MiB (IPS32 covers that).
  for (const format of ["ips32", "ppf", "bps", "ups", "gdiff", "vcdiff"]) {
    add(`large.apply.${format}`, ["large", format], (ctx) => {
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx(`large/sparse.${format}`), out), `large ${format}`);
      ctx.same(out, ctx.fx("large/target.bin"), "large patched output");
    });
    add(`large.parity.${format}.streaming-vs-memory-vs-threads`, ["large", format, "determinism"], (ctx) => {
      const a = ctx.tmp("a.bin");
      const b = ctx.tmp("b.bin");
      const c = ctx.tmp("c.bin");
      ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx(`large/sparse.${format}`), a, ["-j", "1"], { env: { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "268435456" } }), "in-memory tier -j1");
      ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx(`large/sparse.${format}`), b, ["-j", "8"], { env: { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "0" } }), "streaming tier -j8");
      ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx(`large/sparse.${format}`), c, ["-j", "3"]), "default tier -j3");
      ctx.same(b, a, "streaming -j8 vs in-memory -j1");
      ctx.same(c, a, "default -j3 vs in-memory -j1");
    });
  }
  add("large.apply.sha256-matches-independent-computation", ["large"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx("large/sparse.bps"), out), "large bps");
    check(sha(fs.readFileSync(out)) === sha(fs.readFileSync(ctx.fx("large/target.bin"))), "sha256 mismatch");
    const reported = ctx.run(["checksum", "--input", out, "--algo", "sha256"]).stdout;
    check(reported.includes(sha(fs.readFileSync(out))), "rom-weaver checksum sha256 disagrees with node:crypto");
  });
  add("large.apply.to-zip-and-7z-roundtrip", ["large", "output"], (ctx) => {
    for (const ext of ["zip", "7z"]) {
      const out = ctx.tmp(`out.${ext}`);
      ctx.ok(ctx.apply(ctx.fx("large/source.bin"), ctx.fx("large/sparse.bps"), out, ["-j", "4"], { compress: true }), `large -> ${ext}`);
      const dir = ctx.tmp(`ex-${ext}`);
      ctx.ok(ctx.run(["extract", "--input", out, "--output", dir]), `extract ${ext}`);
      const files = fs.readdirSync(dir);
      check(files.length === 1, `expected one file in ${ext}`);
      check(fs.readFileSync(`${dir}/${files[0]}`).equals(fs.readFileSync(ctx.fx("large/target.bin"))), `${ext} payload mismatch`);
    }
  });

  // ------------------------------------------------------------ diagnostics flags
  const small = (ctx, extra, out) => ctx.apply(ctx.fx("rom/base.bin"), ctx.fx("patches/ind/same.bps"), ctx.tmp(out), extra);
  for (const [label, flags] of [["verbose", ["-v"]], ["vv", ["-vv"]], ["trace", ["-vvv"]], ["debug", ["--debug"]], ["log-trace", ["--log-level", "trace"]], ["dep-trace", ["--dep-trace", "--log-level", "trace"]], ["quiet", ["--quiet"]], ["no-progress", ["--no-progress"]], ["progress", ["--progress"]], ["jsonl-progress", ["--jsonl"]]]) {
    add(`diagnostics.output-unchanged.${label}`, ["diagnostics"], (ctx) => {
      const result = small(ctx, flags, "out.bin");
      ctx.ok(result, `flags ${flags.join(" ")}`);
      ctx.same(ctx.tmp("out.bin"), ctx.fx("rom/same.bin"), "patched output");
    });
  }
  add("diagnostics.trace-logs-reach-stderr-not-stdout", ["diagnostics"], (ctx) => {
    const result = small(ctx, ["-vvv", "--json"], "out.bin");
    ctx.ok(result, "-vvv --json");
    ctx.json(result); // stdout must stay a single parseable document
    check(result.stderr.length > 0, "no trace output on stderr at -vvv");
  });
  add("diagnostics.usage-errors-exit-2", ["diagnostics", "negative"], (ctx) => {
    ctx.failed(ctx.run(["patch", "apply"]), { codes: [2], what: "missing --input" });
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--bogus-flag"]), { codes: [2], what: "unknown flag" });
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.ips"), "--threads", "0"]), { what: "--threads 0" });
    ctx.failed(ctx.run(["patch", "apply", "--input", ctx.fx("rom/base.bin"), "--patch", ctx.fx("patches/ind/same.ips"), "--threads", "banana"]), { codes: [2], what: "--threads banana" });
  });
  add("diagnostics.no-patch-and-no-weave-fails-cleanly", ["diagnostics", "negative"], (ctx) => {
    const out = ctx.tmp("out.bin");
    ctx.failed(ctx.apply(ctx.fx("rom/base.bin"), [], out), { what: "no --patch" });
    check(!ctx.exists(out), "left an output");
  });
  // IPS offset 0x454F46 spells "EOF": a record there must not be mistaken for the end marker.
  fixtures.define("ips-eof/base.bin", { where: "cache", purpose: "5 MiB ROM for the IPS EOF-offset collision", how: "xorshift", deterministic: true, build: () => {
    let state = 0x2545f491;
    return Uint8Array.from({ length: 0x500000 }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state & 255;
    });
  } });
  fixtures.define("ips-eof/target.bin", { where: "cache", purpose: "base with edits straddling offset 0x454F46", how: "edit", deterministic: true, build: () => {
    const out = fixtures.bytes("ips-eof/base.bin").slice();
    out[0x454f45] ^= 0xff;
    out[0x454f46] ^= 0xff;
    out[0x454f47] ^= 0xff;
    out[0x100] ^= 1;
    return out;
  } });
  fixtures.define("ips-eof/independent.ips", { where: "cache", purpose: "IPS from the independent encoder (records straddle the EOF offset)", how: "encodeIps", deterministic: true, build: () => E.encodeIps(fixtures.bytes("ips-eof/base.bin"), fixtures.bytes("ips-eof/target.bin")) });
  add("patch.ips.eof-offset-collision.rom-weaver-created", ["ips", "edge"], (ctx) => {
    const patch = ctx.tmp("c.ips");
    ctx.ok(ctx.run(["patch", "create", "--original", ctx.fx("ips-eof/base.bin"), "--modified", ctx.fx("ips-eof/target.bin"), "--output", patch]), "patch create");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("ips-eof/base.bin"), patch, out), "apply");
    ctx.same(out, ctx.fx("ips-eof/target.bin"), "round trip across the EOF offset");
  });
  add("patch.ips.eof-offset-collision.independent-encoder", ["ips", "edge"], (ctx) => {
    // The independent encoder emits a record starting at 0x454F45 (0x45 0x4F 0x45) - harmless - but one run
    // covers 0x454F45..0x454F47 so the decoder never sees a record that begins at exactly 0x454F46.
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("ips-eof/base.bin"), ctx.fx("ips-eof/independent.ips"), out), "apply");
    ctx.same(out, ctx.fx("ips-eof/target.bin"), "output");
  });
  add("diagnostics.json-failure-document", ["diagnostics", "negative", "report"], (ctx) => {
    const result = ctx.run(["patch", "apply", "--input", ctx.fx("rom/wrong.bin"), "--patch", ctx.fx("patches/ind/same.bps"), "--output", ctx.tmp("out.bin"), "--no-compress", "--json"]);
    ctx.failed(result, { codes: [1], what: "bps wrong source with --json" });
    const doc = ctx.json(result);
    check(doc.status === "failed" && doc.exit_code === 1 && doc.error, () => `failure document malformed: ${JSON.stringify({ status: doc.status, exit_code: doc.exit_code, error: doc.error })}`);
  });
  add("diagnostics.json-failure-document.jsonl", ["diagnostics", "negative", "report"], (ctx) => {
    const result = ctx.run(["patch", "apply", "--input", ctx.fx("rom/wrong.bin"), "--patch", ctx.fx("patches/ind/same.bps"), "--output", ctx.tmp("out.bin"), "--no-compress", "--jsonl"]);
    ctx.failed(result, { codes: [1], what: "bps wrong source with --jsonl" });
    const lines = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const last = lines.at(-1);
    check(["failed", "error"].includes(last.status) && last.details?.error?.exit_code === 1, () => `terminal event malformed: ${JSON.stringify(last).slice(0, 300)}`);
  });
  for (const ext of ["7z", "zip", "chd"]) {
    add(`cancel.sigint-leaves-no-partial-output.${ext}`, ["cancel", ext], (ctx) => {
      const out = ctx.tmp(`out.${ext}`);
      const args = ["patch", "apply", "--input", ctx.fx("large/source.bin"), "--patch", ctx.fx("large/sparse.bps"), "--output", out, "-j", "1", "--compress-level", "max"];
      const result = ctx.run(args, { timeout: 120, killSignal: "SIGINT" });
      if (!result.interrupted) {
        ctx.note(`${ext}: apply finished within 120 ms (${result.ms} ms); cancellation was not exercised`);
        return;
      }
      check(result.code === 130 || result.signal === "SIGINT", () => `expected exit 130 after SIGINT, got ${ctx.describe(result)}`);
      const leftovers = fs.readdirSync(ctx.work).filter((name) => name.startsWith("out"));
      check(leftovers.length === 0, () => `cancelled apply left files behind: ${leftovers.join(",")}`);
    });
  }
  add("diagnostics.tui", ["diagnostics", "tui"], () => skip("--tui needs an interactive terminal; covered by Rust tests tui.rs"));
  add("diagnostics.dcp-positive", ["diagnostics", "dcp"], () => skip("see patch.dcp.apply.positive-rebuild"));
  add("diagnostics.reference-xdelta3-flips", ["diagnostics", "reference"], () => skip("xdelta3 and flips are not installed on this host; cross-checks use independent encoders in lib/encoders.mjs and the vendored bsppatch.js oracle instead"));
};
