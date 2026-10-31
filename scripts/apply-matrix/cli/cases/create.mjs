// `patch create` for every creatable patch format: round trips over many ROM pairs, option/flag behavior,
// determinism across -j, overwrite policy, JSON documents, and cross-checks with flips / xdelta3.
import fs from "node:fs";
import path from "node:path";
import { add, check, fail, skip } from "../lib/harness.mjs";
import { needTool, prngBytes, toolIn, toolMust } from "../lib/reference-tools.mjs";

const FORMATS = ["ips", "ips32", "solid", "bps", "ups", "vcdiff", "xdelta", "gdiff", "aps", "apsgba", "rup", "ppf", "pat", "ebp", "bdf", "dps", "mod"];
const SHRINK_REJECTED = ["ips32", "ppf", "ebp", "mod"]; // documented: "patches cannot shrink the output"

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const scattered = (source, seed, count) => {
  const out = source.slice();
  const rnd = prngBytes(count * 4, seed);
  for (let i = 0; i < count; i++) {
    const at = ((rnd[i * 4] << 16) | (rnd[i * 4 + 1] << 8) | rnd[i * 4 + 2]) % out.length;
    out[at] ^= (rnd[i * 4 + 3] | 1);
  }
  return out;
};

/** name -> (ctx) => [original, modified, { sameLength, shrinks }] */
const PAIRS = {
  same: (ctx) => [ctx.bytes("rom/base.bin"), ctx.bytes("rom/same.bin")],
  grow: (ctx) => [ctx.bytes("rom/base.bin"), ctx.bytes("rom/grow.bin")],
  shrink: (ctx) => [ctx.bytes("rom/base.bin"), ctx.bytes("rom/shrink.bin")],
  rle: (ctx) => [ctx.bytes("rom/base.bin"), ctx.bytes("rom/rle.bin")],
  "one-byte": () => [Uint8Array.of(0x00), Uint8Array.of(0x01)],
  "one-to-two": () => [Uint8Array.of(0x41), Uint8Array.of(0x41, 0x42)],
  "two-to-one": () => [Uint8Array.of(0x41, 0x42), Uint8Array.of(0x41)],
  "empty-original": () => [new Uint8Array(0), prngBytes(100, 11)],
  "empty-modified": () => [prngBytes(100, 12), new Uint8Array(0)],
  "header-sized": () => {
    const o = prngBytes(0x200, 13);
    return [o, scattered(o, 14, 3)];
  },
  "insert-middle": () => {
    const o = prngBytes(60000, 15);
    return [o, cat(o.subarray(0, 30000), prngBytes(777, 16), o.subarray(30000))];
  },
  "delete-middle": () => {
    const o = prngBytes(60000, 17);
    return [o, cat(o.subarray(0, 20000), o.subarray(21500))];
  },
  "all-zero-edit": () => {
    const o = new Uint8Array(1 << 20);
    const m = o.slice();
    m[5] = 1;
    m[(1 << 20) - 1] = 9;
    return [o, m];
  },
  "all-bytes-differ": () => {
    const o = prngBytes(5000, 18);
    return [o, o.map((b) => b ^ 0xff)];
  },
  "multi-mib-scattered": () => {
    const o = prngBytes(3 << 20, 19);
    return [o, scattered(o, 20, 200)];
  },
  "eof-offset-0x454f46": () => {
    // IPS reads offset 0x454F46 as the "EOF" marker: edits at that exact address are a classic encoder bug.
    const o = prngBytes(0x454f46 + 64, 21);
    const m = o.slice();
    m[0x454f46] ^= 0x5a;
    m[0x454f47] ^= 0x5a;
    return [o, m];
  },
  "long-run": () => {
    const o = prngBytes(70000, 22);
    const m = o.slice();
    m.fill(0x7e, 1000, 1000 + 66000); // longer than one 16-bit RLE/record length
    return [o, m];
  },
};
const NAME_EMBEDDING = ["solid", "dps"]; // these formats record the patch file name, so only the applied result is comparable
const sameCreated = (ctx, fmt, left, right, o, m, what) => {
  if (NAME_EMBEDDING.includes(fmt)) {
    for (const [name, patch] of [["left", left], ["right", right]]) {
      const out = ctx.tmp(`cmp-${name}.bin`);
      const named = ctx.write(`cmp/${name}.${fmt}`, fs.readFileSync(patch)); // formats without magic need their extension to be sniffed
      ctx.ok(ctx.apply(o, named, out), `apply ${name} patch`);
      ctx.same(out, m, `${fmt} ${name} patch result`);
    }
    return;
  }
  check(fs.readFileSync(left).equals(fs.readFileSync(right)), what);
};
const CORE = ["same", "grow", "shrink", "rle"];

const applyFlags = (fmt) => (fmt === "mod" ? ["--ignore-checksum-validation"] : []);
const createArgs = (orig, mod, out, extra = []) => ["patch", "create", "--original", orig, "--modified", mod, "--output", out, ...extra];

/** Reject reasons that are documented format limits and therefore acceptable, per pair. */
const documentedReject = (fmt, pairName, [orig, mod]) => {
  if (mod.length < orig.length && SHRINK_REJECTED.includes(fmt)) return true;
  if (fmt === "pat" && orig.length !== mod.length) return true;
  if ((fmt === "ips" || fmt === "ebp") && Math.max(orig.length, mod.length) > 0x1000000) return true;
  return false;
};

export const register = () => {
  // ------------------------------------------------------------------ round trip: format x pair
  for (const fmt of FORMATS) {
    for (const pairName of Object.keys(PAIRS)) {
      add(`create.${fmt}.roundtrip.${pairName}`, ["create", fmt, CORE.includes(pairName) ? "core" : "edge"], (ctx) => {
        const pair = PAIRS[pairName](ctx);
        const [orig, mod] = pair;
        const o = ctx.write("orig.bin", orig);
        const m = ctx.write("mod.bin", mod);
        const patch = ctx.tmp(`p.${fmt}`);
        const made = ctx.run(createArgs(o, m, patch));
        if (made.code !== 0) {
          ctx.failed(made, { what: `create ${fmt} ${pairName}` });
          check(!ctx.exists(patch), "failed create left a patch file behind");
          if (documentedReject(fmt, pairName, pair)) return;
          // Not a documented limit: only acceptable for degenerate inputs the user would not patch anyway.
          if (["empty-original", "empty-modified", "one-byte", "one-to-two", "two-to-one"].includes(pairName)) {
            ctx.note(`create ${fmt} rejects ${pairName}: ${ctx.describe(made)}`);
            return;
          }
          fail(`create rejected ${pairName} (not a documented limit): ${ctx.describe(made)}`);
        }
        check(ctx.exists(patch) && fs.statSync(patch).size > 0, "create exited 0 but wrote no patch");
        const out = ctx.tmp("out.bin");
        const applied = ctx.apply(o, patch, out, applyFlags(fmt));
        ctx.ok(applied, `apply created ${fmt} patch (${pairName})`);
        ctx.same(out, m, `${fmt}/${pairName} round trip`);
      });
    }
  }

  // ------------------------------------------------------------------ DLDI (needs a patchable slot)
  add("create.dldi.roundtrip.slot", ["create", "dldi"], (ctx) => {
    const slot = ctx.fx("ext:tests/fixtures/apply-matrix/dldi/slot.nds");
    const driver = ctx.fx("ext:tests/fixtures/apply-matrix/dldi/driver.dldi");
    const patched = ctx.tmp("patched.nds");
    ctx.ok(ctx.apply(slot, driver, patched), "apply DLDI driver");
    const patch = ctx.tmp("p.dldi");
    ctx.ok(ctx.run(createArgs(slot, patched, patch)), "create dldi");
    const out = ctx.tmp("again.nds");
    ctx.ok(ctx.apply(slot, patch, out), "apply created dldi");
    ctx.same(out, patched, "dldi round trip");
  });
  add("create.dldi.rejects-no-slot", ["create", "dldi", "negative"], (ctx) => {
    const patch = ctx.tmp("p.dldi");
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch)), { what: "dldi without slot" });
    check(!ctx.exists(patch), "left a patch behind");
  });

  // ------------------------------------------------------------------ determinism, threads, json
  for (const fmt of FORMATS) {
    add(`create.${fmt}.threads-deterministic`, ["create", fmt, "threads"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const outs = [];
      for (const j of ["1", "2", "8", "auto"]) {
        const p = ctx.tmp(`j${j}/p.${fmt}`); // same leaf name: SOLID/DPS/VCDIFF embed it
        ctx.ok(ctx.run(createArgs(o, m, p, ["-j", j])), `create -j ${j}`);
        outs.push(fs.readFileSync(p));
      }
      for (const buf of outs.slice(1)) check(buf.equals(outs[0]), "patch bytes differ between -j values");
      // repeated runs are byte-stable too (no timestamps/randomness)
      const again = ctx.tmp(`again/p.${fmt}`);
      ctx.ok(ctx.run(createArgs(o, m, again, ["-j", "1"])), "create again");
      check(fs.readFileSync(again).equals(outs[0]), "patch bytes differ between two identical runs");
    });
    add(`create.${fmt}.json-and-jsonl`, ["create", fmt, "json"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp(`p.${fmt}`);
      const result = ctx.ok(ctx.run(createArgs(o, m, patch, ["--json"])), "create --json");
      const doc = ctx.json(result);
      check(doc.command === "patch-create" && doc.status === "succeeded" && doc.exit_code === 0, () => `unexpected json: ${JSON.stringify(doc).slice(0, 300)}`);
      const emitted = doc.details?.emitted_files ?? [];
      check(emitted.length === 1 && emitted[0].size_bytes === fs.statSync(patch).size, () => `emitted_files mismatch: ${JSON.stringify(emitted)}`);
      const lines = ctx.ok(ctx.run(createArgs(o, m, ctx.tmp(`p2.${fmt}`), ["--jsonl"])), "create --jsonl").stdout.trim().split("\n").filter(Boolean);
      check(lines.length >= 1, "no jsonl output");
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          fail(`jsonl line is not JSON: ${line.slice(0, 120)}`);
        }
      }
    });
    add(`create.${fmt}.overwrite-policy`, ["create", fmt, "overwrite"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.write(`p.${fmt}`, "precious");
      const refused = ctx.run(createArgs(o, m, patch));
      ctx.failed(refused, { message: /overwrite|exists|--force/i, what: "create onto existing output" });
      check(fs.readFileSync(patch, "utf8") === "precious", "refused create modified the existing file");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["--force"])), "create --force");
      check(fs.statSync(patch).size > 8, "--force did not replace the file");
    });
    add(`create.${fmt}.plan-and-dry-run-write-nothing`, ["create", fmt, "plan"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp(`p.${fmt}`);
      const plan = ctx.ok(ctx.run(createArgs(o, m, patch, ["--plan"])), "create --plan");
      check(/ips|bps|xdelta/i.test(plan.all), "--plan listed no formats");
      check(!ctx.exists(patch), "--plan wrote a patch");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["--dry-run"])), "create --dry-run");
      check(!ctx.exists(patch), "--dry-run wrote a patch");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["--plan", "--json"])), "create --plan --json");
      check(!ctx.exists(patch), "--plan --json wrote a patch");
    });
    add(`create.${fmt}.format-flag-with-neutral-extension`, ["create", fmt, "format"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("a/patch.out");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["-f", fmt])), `create -f ${fmt} onto patch.out`);
      const viaExt = ctx.tmp(`b/patch.${fmt}`);
      ctx.ok(ctx.run(createArgs(o, m, viaExt)), "create via extension");
      sameCreated(ctx, fmt, patch, viaExt, o, m, "-f output differs from extension-selected output");
    });
    add(`create.${fmt}.unicode-and-space-names`, ["create", fmt, "names"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("ro m ünï ☃.bin", orig);
      const m = ctx.write("mod ünï ☃.bin", mod);
      const patch = ctx.tmp(`sub dir/pätch ☃ x.${fmt}`);
      ctx.ok(ctx.run(createArgs(o, m, patch)), "create with unicode/space paths");
      const out = ctx.tmp("out ☃.bin");
      ctx.ok(ctx.apply(o, patch, out, applyFlags(fmt)), "apply unicode paths");
      ctx.same(out, m, "unicode round trip");
    });
    add(`create.${fmt}.stdout`, ["create", fmt, "stdout"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const viaFile = ctx.tmp(`f/stdout.${fmt}`);
      ctx.ok(ctx.run(createArgs(o, m, viaFile)), "create to file");
      const result = ctx.run(createArgs(o, m, "-", ["-f", fmt]));
      ctx.ok(result, "create --output -");
      const viaStdout = ctx.write(`s/stdout.${fmt}`, result.stdoutBytes);
      sameCreated(ctx, fmt, viaStdout, viaFile, o, m, "stdout patch differs from file patch");
    });
    add(`create.${fmt}.negative-inputs`, ["create", fmt, "negative"], (ctx) => {
      const [orig] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const patch = ctx.tmp(`p.${fmt}`);
      ctx.failed(ctx.run(createArgs(o, ctx.tmp("missing.bin"), patch)), { what: "missing modified" });
      ctx.failed(ctx.run(createArgs(ctx.tmp("missing.bin"), o, patch)), { what: "missing original" });
      ctx.failed(ctx.run(["patch", "create", "--original", o, "--output", patch]), { what: "no --modified and no --code" });
      ctx.failed(ctx.run(["patch", "create", "--modified", o, "--output", patch]), { what: "no --original" });
      ctx.failed(ctx.run(createArgs(o, o, patch, ["-j", "0"])), { what: "-j 0" });
      ctx.failed(ctx.run(createArgs(o, o, patch, ["-j", "nope"])), { what: "-j nope" });
      check(!ctx.exists(patch), "failed commands left a patch");
    });
    add(`create.${fmt}.original-is-directory`, ["create", fmt, "negative"], (ctx) => {
      const dir = ctx.tmp("adir");
      fs.mkdirSync(dir);
      const m = ctx.write("m.bin", PAIRS.same(ctx)[1]);
      const patch = ctx.tmp(`p.${fmt}`);
      ctx.failed(ctx.run(createArgs(dir, m, patch)), { what: "directory original" });
      check(!ctx.exists(patch), "left a patch");
    });
    add(`create.${fmt}.identical-inputs`, ["create", fmt, "edge"], (ctx) => {
      const [orig] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", orig);
      const patch = ctx.tmp(`p.${fmt}`);
      const made = ctx.run(createArgs(o, m, patch));
      if (made.code !== 0) {
        ctx.failed(made, { what: "identical inputs" });
        check(!ctx.exists(patch), "failed create left a patch");
        ctx.note(`create ${fmt} rejects identical inputs: ${ctx.describe(made)}`);
        return;
      }
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(o, patch, out, applyFlags(fmt)), "apply no-op patch");
      ctx.same(out, o, "no-op round trip");
    });
  }

  // ------------------------------------------------------------------ output aliasing the inputs
  for (const which of ["original", "modified"]) {
    add(`create.safety.output-is-the-${which}-with-force`, ["create", "safety", "negative"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.ips", orig);
      const m = ctx.write("m.ips", mod);
      const before = fs.readFileSync(which === "original" ? o : m);
      const result = ctx.run(createArgs(o, m, which === "original" ? o : m, ["--force", "-f", "ips"]));
      check(!result.panic && !result.timedOut, () => ctx.describe(result));
      const after = fs.readFileSync(which === "original" ? o : m);
      if (result.code !== 0) check(after.equals(before), "a failed run destroyed the input");
      else ctx.note(`create --force onto its own ${which} exited 0 (input ${after.equals(before) ? "intact" : "REPLACED by the patch"})`);
    });
  }
  add("create.safety.output-aliases-input-through-symlink", ["create", "safety", "negative"], (ctx) => {
    const [orig, mod] = PAIRS.same(ctx);
    const o = ctx.write("o.bin", orig);
    const m = ctx.write("m.bin", mod);
    const link = ctx.tmp("link.ips");
    try {
      fs.symlinkSync(o, link);
    } catch {
      skip("cannot create symlinks");
    }
    const result = ctx.run(createArgs(o, m, link, ["--force", "-f", "ips"]));
    check(!result.panic, "panic");
    if (result.code === 0) check(fs.readFileSync(o).equals(orig), "create --force through a symlink overwrote the original ROM");
  });

  // ------------------------------------------------------------------ extension / format selection
  add("create.format.unknown-extension-without-flag-fails", ["create", "format", "negative"], (ctx) => {
    const patch = ctx.tmp("p.zzz");
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch)), { what: ".zzz output" });
    check(!ctx.exists(patch), "left a patch");
  });
  add("create.format.unknown-format-flag-fails", ["create", "format", "negative"], (ctx) => {
    const patch = ctx.tmp("p.bps");
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["-f", "nonsense"])), { what: "-f nonsense" });
    check(!ctx.exists(patch), "left a patch");
  });
  add("create.format.non-creatable-formats-rejected", ["create", "format", "negative"], (ctx) => {
    for (const fmt of ["hdiff", "bsp", "ninja1", "hpatchz"]) {
      const patch = ctx.tmp(`p.${fmt}`);
      const result = ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["-f", fmt]));
      ctx.failed(result, { what: `create -f ${fmt}` });
      check(!ctx.exists(patch), `create -f ${fmt} left a patch`);
    }
  });
  for (const [alias, canon] of [["xdelta3", "xdelta"], ["bsdiff", "bdf"], ["BPS", "bps"], ["Ips", "ips"], ["vcdiff", "vcdiff"]]) {
    add(`create.format.alias.${alias}`, ["create", "format"], (ctx) => {
      const [orig, mod] = PAIRS.same(ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("a/alias.out");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["-f", alias])), `-f ${alias}`);
      const canonical = ctx.tmp(`c/alias.${canon}`);
      ctx.ok(ctx.run(createArgs(o, m, canonical)), "canonical");
      check(fs.readFileSync(patch).equals(fs.readFileSync(canonical)), `-f ${alias} differs from .${canon}`);
    });
  }
  add("create.format.flag-disagrees-with-extension", ["create", "format"], (ctx) => {
    const [orig, mod] = PAIRS.same(ctx);
    const o = ctx.write("o.bin", orig);
    const m = ctx.write("m.bin", mod);
    const patch = ctx.tmp("p.ips");
    const made = ctx.run(createArgs(o, m, patch, ["-f", "bps"]));
    if (made.code !== 0) {
      ctx.failed(made, { what: "-f bps onto .ips" });
      check(!ctx.exists(patch), "failed create left a patch");
      return;
    }
    // Whatever wins, the file content and the extension must apply cleanly through content sniffing.
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(o, patch, out), "apply the disagreeing patch");
    ctx.same(out, m, "disagreeing flag round trip");
    ctx.note(`-f bps onto p.ips wrote ${fs.readFileSync(patch).subarray(0, 4).toString("latin1")}...`);
  });

  // ------------------------------------------------------------------ format specific options
  for (const secondary of ["none", "lzma", "djw", "fgk", "auto"]) {
    add(`create.xdelta.secondary.${secondary}`, ["create", "xdelta", "options"], (ctx) => {
      const [orig, mod] = PAIRS["insert-middle"](ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("p.xdelta");
      ctx.ok(ctx.run(createArgs(o, m, patch, ["--xdelta-secondary", secondary])), `--xdelta-secondary ${secondary}`);
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(o, patch, out), "apply");
      ctx.same(out, m, `secondary ${secondary} round trip`);
      if (secondary !== "none") {
        needTool("xdelta3");
        const decoded = ctx.tmp("dec.bin");
        toolMust(toolIn(ctx)("xdelta3", ["-d", "-f", "-s", o, patch, decoded]), `xdelta3 -d secondary=${secondary}`);
        ctx.same(decoded, m, `xdelta3 decode of secondary=${secondary}`);
      }
    });
  }
  add("create.xdelta.secondary.invalid-value", ["create", "xdelta", "negative"], (ctx) => {
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), ctx.tmp("p.xdelta"), ["--xdelta-secondary", "gzip"])), { what: "invalid secondary" });
  });
  add("create.xdelta.secondary.shrinks-compressible-patch", ["create", "xdelta", "options"], (ctx) => {
    const o = new Uint8Array(200000);
    const m = o.slice();
    const words = Buffer.from("the quick brown fox jumps over the lazy dog while compressing xdelta secondary payloads ");
    for (let i = 0; i < m.length; i++) m[i] = words[(i * 7 + (i >> 9)) % words.length];
    const op = ctx.write("o.bin", o);
    const mp = ctx.write("m.bin", m);
    const none = ctx.tmp("none.xdelta");
    const lzma = ctx.tmp("lzma.xdelta");
    ctx.ok(ctx.run(createArgs(op, mp, none, ["--xdelta-secondary", "none"])), "none");
    ctx.ok(ctx.run(createArgs(op, mp, lzma, ["--xdelta-secondary", "lzma"])), "lzma");
    check(fs.statSync(lzma).size < fs.statSync(none).size, () => `lzma secondary (${fs.statSync(lzma).size}) not smaller than none (${fs.statSync(none).size})`);
  });
  add("create.ppf.ppf-undo-flag", ["create", "ppf", "options"], (ctx) => {
    const patch = ctx.tmp("p.ppf");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--ppf-undo"])), "create --ppf-undo");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out), "apply ppf with undo data");
    ctx.same(out, ctx.fx("rom/same.bin"), "ppf-undo round trip");
    const back = ctx.tmp("undone.bin");
    ctx.ok(ctx.run(["tools", "ppf-undo", "--input", out, "--patch", patch, "--output", back, "--no-compress"]), "tools ppf-undo");
    ctx.same(back, ctx.fx("rom/base.bin"), "ppf-undo restores the original");
  });
  add("create.solid.metadata-flags", ["create", "solid", "options"], (ctx) => {
    const patch = ctx.tmp("p.solid");
    ctx.ok(
      ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--solid-system", "snes", "--solid-game", "Gämé ☃", "--solid-hack", "Hack", "--solid-version", "1.2", "--solid-author", "me", "--solid-contact", "me@example.invalid", "--solid-comment", "multi word comment"])),
      "create solid with metadata",
    );
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out), "apply extended solid");
    ctx.same(out, ctx.fx("rom/same.bin"), "extended solid round trip");
    const probe = ctx.run(["patch", "validate", "--input", ctx.fx("rom/base.bin"), "--patch", patch, "--json"]);
    ctx.ok(probe, "validate extended solid");
  });
  add("create.solid.extended-flag-only", ["create", "solid", "options"], (ctx) => {
    const a = ctx.tmp("a.solid");
    const b = ctx.tmp("b.solid");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), a)), "plain");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), b, ["--solid-extended"])), "--solid-extended");
    check(fs.statSync(b).size >= fs.statSync(a).size, "extended header patch smaller than plain");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), b, out), "apply");
    ctx.same(out, ctx.fx("rom/same.bin"), "extended-only round trip");
  });
  add("create.options.solid-flags-on-other-format-are-rejected-or-ignored", ["create", "options", "negative"], (ctx) => {
    const patch = ctx.tmp("p.bps");
    const r = ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--solid-game", "x"]));
    check(!r.panic, "panic");
    if (r.code === 0) ctx.note("--solid-game on a BPS create is silently ignored");
  });
  add("create.options.checksum-name-token", ["create", "options"], (ctx) => {
    const patch = ctx.tmp("p.ips");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--checksum-name"])), "create --checksum-name");
    const produced = fs.readdirSync(ctx.work).filter((n) => /\[crc32:[0-9a-f]{8}\]/i.test(n));
    check(produced.length === 1, () => `expected one file named with [crc32:...], got ${fs.readdirSync(ctx.work).join(",")}`);
    // The token must be honoured on apply: wrong source gets rejected, right source accepted.
    const tokened = path.join(ctx.work, produced[0]);
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), tokened, out), "apply right source");
    ctx.same(out, ctx.fx("rom/same.bin"), "checksum-name round trip");
    ctx.failed(ctx.apply(ctx.fx("rom/wrong.bin"), tokened, ctx.tmp("bad.bin")), { what: "apply wrong source with crc token" });
  });
  add("create.options.assume-in", ["create", "options"], (ctx) => {
    const patch = ctx.tmp("p.bps");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--assume-in", "crc32=deadbeef"])), "create --assume-in");
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), ctx.tmp("q.bps"), ["--assume-in", "crc32=zzzz"])), { what: "bad --assume-in" });
    ctx.failed(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), ctx.tmp("r.bps"), ["--assume-in", "nope=00"])), { what: "unknown algo" });
  });
  add("create.options.ignore-checksum-validation", ["create", "options"], (ctx) => {
    const patch = ctx.tmp("p.bps");
    ctx.ok(ctx.run(createArgs(ctx.fx("rom/base.bin"), ctx.fx("rom/same.bin"), patch, ["--ignore-checksum-validation"])), "create --ignore-checksum-validation");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(ctx.fx("rom/base.bin"), patch, out, ["--ignore-checksum-validation"]), "apply");
    ctx.same(out, ctx.fx("rom/same.bin"), "output");
  });

  // ------------------------------------------------------------------ containers as create input
  add("create.input.archives-are-compared-as-raw-files", ["create", "container"], (ctx) => {
    const o = ctx.write("o.bin", PAIRS.same(ctx)[0]);
    const zipped = ctx.tmp("orig.zip");
    ctx.ok(ctx.run(["compress", "--input", o, "--output", zipped]), "compress original to zip");
    const m = ctx.write("m.bin", PAIRS.same(ctx)[1]);
    const patch = ctx.tmp("p.xdelta");
    ctx.ok(ctx.run(createArgs(zipped, m, patch)), "create with zip original");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(zipped, patch, out, ["--no-extract"]), "apply to raw zip");
    ctx.same(out, m, "raw-container patch");
  });

  // ------------------------------------------------------------------ cross-checks with reference tools
  const crossPairs = ["same", "grow", "shrink", "rle", "insert-middle", "multi-mib-scattered"];
  for (const pairName of crossPairs) {
    add(`create.reference.flips-applies-rom-weaver-ips.${pairName}`, ["create", "reference", "flips", "ips"], (ctx) => {
      needTool("flips");
      const [orig, mod] = PAIRS[pairName](ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("p.ips");
      ctx.ok(ctx.run(createArgs(o, m, patch)), "create ips");
      const out = ctx.tmp("flips.bin");
      toolMust(toolIn(ctx)("flips", ["--apply", patch, o, out]), "flips --apply (rom-weaver ips)");
      ctx.same(out, m, "flips output");
    });
    add(`create.reference.flips-applies-rom-weaver-bps.${pairName}`, ["create", "reference", "flips", "bps"], (ctx) => {
      needTool("flips");
      const [orig, mod] = PAIRS[pairName](ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("p.bps");
      ctx.ok(ctx.run(createArgs(o, m, patch)), "create bps");
      const out = ctx.tmp("flips.bin");
      toolMust(toolIn(ctx)("flips", ["--apply", patch, o, out]), "flips --apply (rom-weaver bps)");
      ctx.same(out, m, "flips output");
    });
    for (const fmt of ["xdelta", "vcdiff"]) {
      add(`create.reference.xdelta3-decodes-rom-weaver-${fmt}.${pairName}`, ["create", "reference", "xdelta3", fmt], (ctx) => {
        needTool("xdelta3");
        const [orig, mod] = PAIRS[pairName](ctx);
        const o = ctx.write("o.bin", orig);
        const m = ctx.write("m.bin", mod);
        const patch = ctx.tmp(`p.${fmt}`);
        ctx.ok(ctx.run(createArgs(o, m, patch)), `create ${fmt}`);
        const out = ctx.tmp("x3.bin");
        toolMust(toolIn(ctx)("xdelta3", ["-d", "-f", "-s", o, patch, out]), `xdelta3 -d (rom-weaver ${fmt})`);
        ctx.same(out, m, "xdelta3 output");
      });
    }
  }
  for (const pairName of ["same", "grow"]) {
    add(`create.reference.rom-weaver-applies-flips-ips-from-create-pair.${pairName}`, ["create", "reference", "flips"], (ctx) => {
      needTool("flips");
      const [orig, mod] = PAIRS[pairName](ctx);
      const o = ctx.write("o.bin", orig);
      const m = ctx.write("m.bin", mod);
      const patch = ctx.tmp("f.ips");
      toolMust(toolIn(ctx)("flips", ["--create", "--ips", o, m, patch]), "flips --create --ips");
      const out = ctx.tmp("out.bin");
      ctx.ok(ctx.apply(o, patch, out), "apply flips ips");
      ctx.same(out, m, "output");
    });
  }
  add("create.reference.xdelta3-created-roundtrips-through-rom-weaver-create-apply", ["create", "reference", "xdelta3"], (ctx) => {
    needTool("xdelta3");
    const [orig, mod] = PAIRS["insert-middle"](ctx);
    const o = ctx.write("o.bin", orig);
    const m = ctx.write("m.bin", mod);
    const theirs = ctx.tmp("theirs.xdelta");
    toolMust(toolIn(ctx)("xdelta3", ["-e", "-f", "-s", o, m, theirs]), "xdelta3 -e");
    const out = ctx.tmp("out.bin");
    ctx.ok(ctx.apply(o, theirs, out), "apply xdelta3 -e output");
    ctx.same(out, m, "output");
  });
  add("create.size.sanity-delta-formats-are-compact", ["create", "size"], (ctx) => {
    const [orig, mod] = PAIRS["insert-middle"](ctx);
    const o = ctx.write("o.bin", orig);
    const m = ctx.write("m.bin", mod);
    const sizes = {};
    for (const fmt of ["bps", "xdelta", "vcdiff", "bdf", "gdiff", "ups", "rup"]) {
      const patch = ctx.tmp(`s.${fmt}`);
      ctx.ok(ctx.run(createArgs(o, m, patch)), `create ${fmt}`);
      sizes[fmt] = fs.statSync(patch).size;
    }
    // A 777-byte insertion in 60 kB: a delta format that stores the whole file again is a regression.
    for (const [fmt, size] of Object.entries(sizes)) {
      if (size > mod.length) ctx.note(`${fmt} patch (${size} B) larger than the modified file (${mod.length} B) for a 777-byte insertion`);
    }
    check(sizes.bps < mod.length / 2, () => `bps patch ${sizes.bps} B for a 777-byte insertion in ${mod.length} B`);
    check(sizes.xdelta < mod.length / 2, () => `xdelta patch ${sizes.xdelta} B for a 777-byte insertion`);
  });
};
