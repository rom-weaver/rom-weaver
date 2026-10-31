// `rom-weaver compress`: every writable format (zip, 7z, chd, rvz, z3ds) x codec x level, invalid combinations,
// threads, JSON documents, stdin/stdout, overwrite policy, odd inputs, and verification with the reference tools.
import fs from "node:fs";
import path from "node:path";
import { add, check, fail, skip } from "../lib/harness.mjs";
import { filesUnder, needTool, prngBytes, toolIn, toolMust } from "../lib/reference-tools.mjs";

const LEVELS = ["min", "very-low", "low", "medium", "high", "very-high", "max"];
const ZIP_CODECS = ["store", "deflate", "zstd"];
const CHD_CD_CODECS = ["cdzs", "cdlz", "cdzl", "cdfl"];
const CHD_RAW_CODECS = ["zstd", "lzma", "zlib", "flac", "store"];

/** Compressible, non-trivial text-like payload so that level/codec choices change the output size. */
const textLike = (length, seed = 5) => {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  const rnd = prngBytes(length, seed);
  const out = Buffer.alloc(length);
  let at = 0;
  let i = 0;
  while (at < length) {
    at += out.write(`${words[rnd[i++ % rnd.length] % words.length]}${rnd[i++ % rnd.length] % 97} `, at);
  }
  return out;
};

let extractSeq = 0;
const extractAll = (ctx, file, dir) => {
  const target = ctx.tmp(`${dir ?? "rb"}-${++extractSeq}`);
  ctx.ok(ctx.run(["extract", "--input", file, "--output", target, "--no-ignore"]), `extract ${path.basename(file)}`);
  return filesUnder(target);
};
const extractOneFile = (ctx, file, dir) => {
  const files = extractAll(ctx, file, dir);
  check(files.length === 1, () => `expected one extracted file from ${path.basename(file)}, got ${files.map((f) => path.basename(f)).join(",") || "none"}`);
  return files[0];
};
/** Extract and return the one payload, treating a CUE+BIN pair as the BIN (an ISO packed as CD media comes back that way). */
const extractPayload = (ctx, file, dir) => {
  const files = extractAll(ctx, file, dir);
  const bins = files.filter((f) => f.endsWith(".bin"));
  if (files.length === 2 && bins.length === 1 && files.some((f) => f.endsWith(".cue"))) return bins[0];
  check(files.length === 1, () => `expected one extracted file from ${path.basename(file)}, got ${files.map((f) => path.basename(f)).join(",") || "none"}`);
  return files[0];
};
const compressTo = (ctx, input, output, extra = []) => ctx.run(["compress", "--input", input, "--output", output, ...extra]);

export const register = () => {
  // ================================================================== zip / 7z
  const archiveCases = [
    ["zip", ZIP_CODECS],
    ["7z", ["lzma2"]],
  ];
  const verifyArchive = (ctx, fmt, archive, expected) => {
    const file = extractOneFile(ctx, archive);
    check(fs.readFileSync(file).equals(expected), `${fmt} round trip through rom-weaver extract differs`);
  };
  for (const [fmt, codecs] of archiveCases) {
    for (const codec of codecs) {
      for (const level of [...LEVELS, "default"]) {
        add(`compress.${fmt}.${codec}.level-${level}`, ["compress", fmt, codec, "levels"], (ctx) => {
          const data = textLike(300000);
          const input = ctx.write("game.bin", data);
          const out = ctx.tmp(`out.${fmt}`);
          ctx.ok(compressTo(ctx, input, out, ["--codec", codec, ...(level === "default" ? [] : ["--level", level])]), `compress ${fmt} ${codec} ${level}`);
          verifyArchive(ctx, fmt, out, data);
          const tool = fmt === "zip" ? "unzip" : "7z";
          if (!(fmt === "zip" && codec === "zstd")) {
            needTool(tool);
            toolMust(toolIn(ctx)(tool, fmt === "zip" ? ["-tq", out] : ["t", out]), `${tool} test`);
          } else if (level === "default") {
            needTool("7z");
            const r = toolIn(ctx)("7z", ["t", out]);
            ctx.note(`7z t on zip+zstd: ${r.ok ? "ok" : "unsupported by 7z"}`);
          }
        });
      }
      add(`compress.${fmt}.${codec}.codec-colon-level-syntax`, ["compress", fmt, codec, "levels"], (ctx) => {
        const data = textLike(100000);
        const input = ctx.write("game.bin", data);
        for (const lvl of ["0", "1", "5", "9", "19", "22"]) {
          const out = ctx.tmp(`c${lvl}.${fmt}`);
          const result = compressTo(ctx, input, out, ["--codec", `${codec}:${lvl}`]);
          if (result.code === 0) verifyArchive(ctx, fmt, out, data);
          else {
            ctx.failed(result, { what: `${codec}:${lvl}` });
            check(!ctx.exists(out), `failed ${codec}:${lvl} left output`);
            ctx.note(`${fmt} ${codec}:${lvl} rejected: ${ctx.describe(result)}`);
          }
        }
      });
      add(`compress.${fmt}.${codec}.higher-level-is-not-larger`, ["compress", fmt, codec, "levels"], (ctx) => {
        if (codec === "store") skip("store has no level");
        const input = ctx.write("game.bin", textLike(1 << 20));
        const sizes = {};
        for (const level of ["min", "max"]) {
          const out = ctx.tmp(`${level}.${fmt}`);
          ctx.ok(compressTo(ctx, input, out, ["--codec", codec, "--level", level]), `${level}`);
          sizes[level] = fs.statSync(out).size;
        }
        check(sizes.max <= sizes.min, () => `--level max (${sizes.max} B) larger than --level min (${sizes.min} B)`);
      });
      add(`compress.${fmt}.${codec}.threads`, ["compress", fmt, codec, "threads"], (ctx) => {
        const data = textLike(1 << 20, 9);
        const input = ctx.write("game.bin", data);
        const outs = {};
        for (const j of ["1", "2", "8", "auto"]) {
          const out = ctx.tmp(`j${j}/out.${fmt}`);
          ctx.ok(compressTo(ctx, input, out, ["--codec", codec, "--level", "medium", "-j", j]), `-j ${j}`);
          verifyArchive(ctx, fmt, out, data);
          outs[j] = fs.readFileSync(out);
        }
        const identical = Object.values(outs).every((b) => b.equals(outs["1"]));
        if (!identical) ctx.note(`${fmt}/${codec}: output bytes differ between -j values (sizes ${Object.entries(outs).map(([k, v]) => `${k}=${v.length}`).join(" ")})`);
        const again = ctx.tmp(`again/out.${fmt}`);
        ctx.ok(compressTo(ctx, input, again, ["--codec", codec, "--level", "medium", "-j", "1"]), "repeat");
        check(fs.readFileSync(again).equals(outs["1"]), "two identical -j 1 runs gave different bytes");
      });
    }
    add(`compress.${fmt}.default-codec-and-level`, ["compress", fmt], (ctx) => {
      const data = textLike(200000);
      const input = ctx.write("game.bin", data);
      const out = ctx.tmp(`out.${fmt}`);
      ctx.ok(compressTo(ctx, input, out), "compress with defaults");
      verifyArchive(ctx, fmt, out, data);
      check(fs.statSync(out).size < data.length / 2, "default output is not meaningfully compressed");
    });
    for (const [what, args] of [
      ["bogus-codec", ["--codec", "bogus"]],
      ["other-format-codec", ["--codec", fmt === "zip" ? "lzma2" : "deflate"]],
      ["chd-codec", ["--codec", "cdzs"]],
      ["empty-codec", ["--codec", ""]],
      ["bogus-level", ["--level", "ultra"]],
      ["numeric-level", ["--level", "5"]],
      ["uppercase-level", ["--level", "MAX"]],
      ["codec-level-garbage", ["--codec", `${fmt === "zip" ? "deflate" : "lzma2"}:abc`]],
      ["codec-level-negative", ["--codec", `${fmt === "zip" ? "deflate" : "lzma2"}:-1`]],
      ["codec-level-huge", ["--codec", `${fmt === "zip" ? "deflate" : "lzma2"}:999999`]],
      ["codec-level-trailing-colon", ["--codec", `${fmt === "zip" ? "deflate" : "lzma2"}:`]],
      ["threads-zero", ["-j", "0"]],
      ["threads-garbage", ["-j", "lots"]],
      ["threads-negative", ["-j", "-3"]],
      ["unknown-flag", ["--no-such-flag"]],
    ]) {
      add(`compress.${fmt}.invalid.${what}`, ["compress", fmt, "negative"], (ctx) => {
        const out = ctx.tmp(`out.${fmt}`);
        const result = compressTo(ctx, ctx.fx("rom/base.bin"), out, args);
        ctx.failed(result, { what: `compress ${fmt} ${args.join(" ")}` });
        check(!ctx.exists(out), "failed compress left an output file");
      });
    }
    add(`compress.${fmt}.multiple-inputs`, ["compress", fmt, "multi"], (ctx) => {
      const a = ctx.write("in/a.bin", textLike(5000, 1));
      const b = ctx.write("in/sub/b.bin", textLike(7000, 2));
      const c = ctx.write("in/ünï ☃ c.txt", "hello");
      const out = ctx.tmp(`out.${fmt}`);
      ctx.ok(ctx.run(["compress", "--input", a, "--input", b, "--input", c, "--output", out, "--level", "low"]), "multi-input compress");
      const files = extractAll(ctx, out, "multi-ex");
      const byName = new Map(files.map((f) => [path.basename(f), fs.readFileSync(f)]));
      check(byName.size === 3, () => `expected 3 members, got ${[...byName.keys()].join(",")}`);
      check(byName.get("a.bin")?.equals(fs.readFileSync(a)) && byName.get("b.bin")?.equals(fs.readFileSync(b)) && byName.get("ünï ☃ c.txt")?.toString() === "hello", "member bytes differ");
      const positional = ctx.tmp(`pos.${fmt}`);
      ctx.ok(ctx.run(["compress", a, b, "--output", positional]), "positional FILE... inputs");
      check(extractAll(ctx, positional, "pos-ex").length === 2, "positional inputs lost a member");
    });
    add(`compress.${fmt}.directory-input`, ["compress", fmt, "multi"], (ctx) => {
      ctx.write("tree/a.bin", textLike(3000, 3));
      ctx.write("tree/d1/d2/deep.bin", textLike(3000, 4));
      const out = ctx.tmp(`out.${fmt}`);
      const result = ctx.run(["compress", "--input", path.join(ctx.work, "tree"), "--output", out]);
      if (result.code !== 0) {
        ctx.failed(result, { what: "directory input" });
        check(!ctx.exists(out), "failed run left output");
        ctx.note(`${fmt}: directory input rejected cleanly: ${ctx.describe(result)}`);
        return;
      }
      const names = extractAll(ctx, out, "tree-ex").map((f) => path.basename(f)).sort();
      check(names.join() === "a.bin,deep.bin", () => `directory members: ${names}`);
    });
    add(`compress.${fmt}.empty-and-tiny-inputs`, ["compress", fmt, "edge"], (ctx) => {
      for (const [name, bytes] of [["empty.bin", Buffer.alloc(0)], ["one.bin", Buffer.from([0x7f])], ["two.bin", Buffer.from([0, 0])], ["zeros.bin", Buffer.alloc(65536)]]) {
        const input = ctx.write(name, bytes);
        const out = ctx.tmp(`${name}.${fmt}`);
        ctx.ok(compressTo(ctx, input, out), `compress ${name}`);
        const files = extractAll(ctx, out, `ex-${name}`);
        check(files.length === 1 && fs.readFileSync(files[0]).equals(bytes), `${name} round trip failed`);
        if (fmt === "zip") {
          needTool("unzip");
          toolMust(toolIn(ctx)("unzip", ["-tq", out]), `unzip -t ${name}`);
        } else {
          needTool("7z");
          toolMust(toolIn(ctx)("7z", ["t", out]), `7z t ${name}`);
        }
      }
    });
    add(`compress.${fmt}.incompressible-input-does-not-explode`, ["compress", fmt, "edge"], (ctx) => {
      const data = Buffer.from(prngBytes(1 << 20, 77));
      const input = ctx.write("rand.bin", data);
      const out = ctx.tmp(`out.${fmt}`);
      ctx.ok(compressTo(ctx, input, out), "compress random data");
      check(fs.statSync(out).size < data.length * 1.02, () => `random data grew to ${fs.statSync(out).size} from ${data.length}`);
      verifyArchive(ctx, fmt, out, data);
    });
    add(`compress.${fmt}.unicode-and-space-names`, ["compress", fmt, "names"], (ctx) => {
      const data = textLike(4000);
      const input = ctx.write("my gämé ☃ [v1.0] (USA).bin", data);
      const out = ctx.tmp(`dir ünï/ä ö.${fmt}`);
      ctx.ok(compressTo(ctx, input, out), "unicode compress");
      const files = extractAll(ctx, out);
      check(files.length === 1 && path.basename(files[0]) === "my gämé ☃ [v1.0] (USA).bin", () => `member name: ${files.map((f) => path.basename(f))}`);
      check(fs.readFileSync(files[0]).equals(data), "bytes differ");
    });
    add(`compress.${fmt}.overwrite-policy`, ["compress", fmt, "overwrite"], (ctx) => {
      const input = ctx.write("game.bin", textLike(2000));
      const out = ctx.write(`out.${fmt}`, "precious");
      ctx.failed(compressTo(ctx, input, out), { message: /overwrite|exists|--force/i, what: "existing output" });
      check(fs.readFileSync(out, "utf8") === "precious", "refused run changed the file");
      ctx.ok(compressTo(ctx, input, out, ["--force"]), "--force");
      check(fs.statSync(out).size > 20, "--force did not replace");
    });
    add(`compress.${fmt}.dry-run-writes-nothing`, ["compress", fmt, "dryrun"], (ctx) => {
      const input = ctx.write("game.bin", textLike(2000));
      const out = ctx.tmp(`out.${fmt}`);
      ctx.ok(compressTo(ctx, input, out, ["--dry-run"]), "--dry-run");
      check(!ctx.exists(out), "dry-run wrote output");
      ctx.ok(compressTo(ctx, input, out, ["--dry-run", "--json"]), "--dry-run --json");
      check(!ctx.exists(out), "dry-run --json wrote output");
    });
    add(`compress.${fmt}.json-and-jsonl`, ["compress", fmt, "json"], (ctx) => {
      const input = ctx.write("game.bin", textLike(50000));
      const out = ctx.tmp(`out.${fmt}`);
      const doc = ctx.json(ctx.ok(compressTo(ctx, input, out, ["--json"]), "--json"));
      check(doc.command === "compress" && doc.status === "succeeded" && doc.exit_code === 0, () => JSON.stringify(doc).slice(0, 300));
      const emitted = doc.details?.emitted_files ?? [];
      check(emitted.length === 1 && emitted[0].size_bytes === fs.statSync(out).size, () => `emitted_files: ${JSON.stringify(emitted)}`);
      const out2 = ctx.tmp(`out2.${fmt}`);
      const lines = ctx.ok(compressTo(ctx, input, out2, ["--jsonl"]), "--jsonl").stdout.trim().split("\n").filter(Boolean);
      check(lines.length >= 1, "no jsonl");
      for (const line of lines) JSON.parse(line);
      const failure = ctx.run(["compress", "--input", ctx.tmp("missing.bin"), "--output", ctx.tmp(`m.${fmt}`), "--json"]);
      ctx.failed(failure, { what: "missing input --json" });
      const failDoc = ctx.json(failure);
      check(failDoc.status === "failed" && failDoc.exit_code === failure.code && failDoc.error, () => `failure doc: ${JSON.stringify(failDoc).slice(0, 300)}`);
    });
    add(`compress.${fmt}.stdin-input`, ["compress", fmt, "stdin"], (ctx) => {
      const data = textLike(30000);
      const out = ctx.tmp(`out.${fmt}`);
      const result = ctx.run(["compress", "--input", "-", "--output", out, "--stdin-name", "from stdin.bin"], { input: data });
      ctx.ok(result, "stdin compress");
      const files = extractAll(ctx, out);
      check(files.length === 1 && path.basename(files[0]) === "from stdin.bin" && fs.readFileSync(files[0]).equals(data), () => `stdin member: ${files.map((f) => path.basename(f))}`);
      const dflt = ctx.tmp(`dflt.${fmt}`);
      ctx.ok(ctx.run(["compress", "-i", "-", "-o", dflt], { input: data }), "stdin without name");
      check(path.basename(extractAll(ctx, dflt, "dflt-ex")[0]) === "stdin.bin", "default stdin name is not stdin.bin");
      ctx.failed(ctx.run(["compress", "-i", "-", "-o", ctx.tmp(`bad.${fmt}`), "--stdin-name", "a/b.bin"], { input: data }), { what: "stdin name with a directory" });
    });
    add(`compress.${fmt}.stdout-output`, ["compress", fmt, "stdout"], (ctx) => {
      const data = textLike(30000);
      const input = ctx.write("game.bin", data);
      const result = ctx.run(["compress", "--input", input, "--output", "-", "--format", fmt]);
      ctx.ok(result, "compress -o -");
      const file = ctx.write(`from-stdout.${fmt}`, result.stdoutBytes);
      check(fs.readFileSync(extractOneFile(ctx, file)).equals(data), "stdout archive differs");
      ctx.failed(ctx.run(["compress", "--input", input, "--output", "-"]), { what: "stdout without --format" });
    });
    add(`compress.${fmt}.format-flag-vs-extension`, ["compress", fmt, "format"], (ctx) => {
      const input = ctx.write("game.bin", textLike(5000));
      const neutral = ctx.tmp("archive.dat");
      ctx.ok(ctx.run(["compress", "-i", input, "-o", neutral, "-f", fmt]), "-f with neutral extension");
      check(fs.readFileSync(extractOneFile(ctx, neutral, "n-ex")).length === 5000, "neutral extension round trip");
      const mismatch = ctx.tmp(`mismatch.${fmt === "zip" ? "7z" : "zip"}`);
      const result = ctx.run(["compress", "-i", input, "-o", mismatch, "-f", fmt]);
      ctx.ok(result, "-f disagreeing with extension");
      check(/warn/i.test(result.all), "no warning when -f disagrees with the extension");
      const head = fs.readFileSync(mismatch).subarray(0, 4).toString("latin1");
      check(fmt === "zip" ? head.startsWith("PK") : head.startsWith("7z"), () => `-f ${fmt} did not win: file starts with ${JSON.stringify(head)}`);
    });
  }
  add("compress.zip.stored-entry-matches-input-bytes", ["compress", "zip", "store"], (ctx) => {
    const data = Buffer.from(prngBytes(40000, 3));
    const input = ctx.write("game.bin", data);
    const out = ctx.tmp("out.zip");
    ctx.ok(compressTo(ctx, input, out, ["--codec", "store"]), "store");
    check(fs.readFileSync(out).includes(data), "stored zip does not contain the raw bytes");
  });
  add("compress.zip.zip64-boundary", ["compress", "zip", "large"], (ctx) => {
    // Many members in one archive (the 65535-entry zip64 threshold itself is too slow for the default run).
    const inputs = [];
    for (let i = 0; i < 300; i++) inputs.push(ctx.write(`many/f${String(i).padStart(4, "0")}.bin`, Buffer.from([i & 255, i >> 8])));
    const out = ctx.tmp("many.zip");
    ctx.ok(ctx.run(["compress", ...inputs.flatMap((f) => ["--input", f]), "--output", out]), "300 members");
    needTool("unzip");
    toolMust(toolIn(ctx)("unzip", ["-tq", out]), "unzip -t");
    check(extractAll(ctx, out).length === 300, "member count");
  });

  // ================================================================== CHD
  const chdSources = [
    ["cd-data", "exh/cd/data.cue", "exh/cd/data.bin", "cd"],
    ["cd-mixed", "exh/cd/mixed.cue", "exh/cd/mixed.bin", "cd"],
  ];
  const verifyChd = (ctx, chd, { codec, fxBin, kind }) => {
    needTool("chdman");
    if (codec !== "store") {
      const v = toolIn(ctx)("chdman", ["verify", "-i", chd]);
      check(v.ok && /verification successful/i.test(v.text), () => `chdman verify: ${v.text.slice(-200)}`);
    }
    if (kind === "cd") {
      const cue2 = ctx.tmp("chdman-extract/out.cue");
      toolMust(toolIn(ctx)("chdman", ["extractcd", "-i", chd, "-o", cue2, "-ob", ctx.tmp("chdman-extract/out.bin"), "-f"]), "chdman extractcd");
      ctx.same(ctx.tmp("chdman-extract/out.bin"), ctx.fx(fxBin), "chdman extractcd bin");
    }
  };
  for (const [name, cue, bin, kind] of chdSources) {
    for (const codec of CHD_CD_CODECS) {
      for (const level of ["min", "medium", "max"]) {
        add(`compress.chd.${name}.${codec}.level-${level}`, ["compress", "chd", "levels", codec], (ctx) => {
          ctx.fx(bin);
          const out = ctx.tmp("out.chd");
          ctx.ok(compressTo(ctx, ctx.fx(cue), out, ["--codec", codec, "--level", level]), `chd ${codec} ${level}`);
          verifyChd(ctx, out, { codec, fxBin: bin, kind });
          const extracted = extractAll(ctx, out, "rw-ex").find((f) => f.endsWith(".bin"));
          check(extracted && fs.readFileSync(extracted).equals(fs.readFileSync(ctx.fx(bin))), "rom-weaver extract of the CHD differs from the source bin");
        });
      }
    }
    add(`compress.chd.${name}.codec-list`, ["compress", "chd", "codec-list"], (ctx) => {
      ctx.fx(bin);
      for (const list of ["cdzs:19,cdzl,cdfl", "cdlz,cdzl", "cdfl,cdzs", "cdzs:1", "cdzs,cdzs"]) {
        const out = ctx.tmp(`l-${list.replace(/\W/g, "_")}.chd`);
        const result = compressTo(ctx, ctx.fx(cue), out, ["--codec", list]);
        if (result.code === 0) verifyChd(ctx, out, { codec: list, fxBin: bin, kind });
        else {
          ctx.failed(result, { what: list });
          ctx.note(`chd codec list ${list} rejected: ${ctx.describe(result)}`);
        }
      }
    });
    add(`compress.chd.${name}.default-matches-chdman-default`, ["compress", "chd", "reference"], (ctx) => {
      needTool("chdman");
      ctx.fx(bin);
      const out = ctx.tmp("rw.chd");
      ctx.ok(compressTo(ctx, ctx.fx(cue), out), "default chd");
      const ref = ctx.tmp("ref.chd");
      toolMust(toolIn(ctx)("chdman", ["createcd", "-i", ctx.fx(cue), "-o", ref, "-f"]), "chdman createcd");
      const sha = (file) => /\nData SHA1:\s+(\w+)/.exec(toolMust(toolIn(ctx)("chdman", ["info", "-i", file]), "chdman info").text)?.[1];
      const meta = (file) => toolIn(ctx)("chdman", ["info", "-v", "-i", file]).text.split("\n").filter((l) => !/^(Input file|CHD size|Ratio|SHA1|Compression)/.test(l)).join("").replace(/\s+/g, " "); // chdman wraps long lines at a path-dependent column
      check(sha(out) === sha(ref), "Data SHA1 differs from chdman createcd");
      check(meta(out) === meta(ref), () => `track metadata differs from chdman:\n${meta(out)}\n---\n${meta(ref)}`);
    });
    add(`compress.chd.${name}.threads-parity`, ["compress", "chd", "threads"], (ctx) => {
      ctx.fx(bin);
      const bytes = {};
      for (const j of ["1", "4", "auto"]) {
        const out = ctx.tmp(`j${j}/out.chd`);
        ctx.ok(compressTo(ctx, ctx.fx(cue), out, ["-j", j, "--level", "medium"]), `-j ${j}`);
        bytes[j] = fs.readFileSync(out);
      }
      check(bytes["1"].equals(bytes["4"]) && bytes["1"].equals(bytes.auto), "CHD bytes differ between -j values");
    });
    add(`compress.chd.${name}.invalid-codecs`, ["compress", "chd", "negative"], (ctx) => {
      ctx.fx(bin);
      for (const codec of ["huff", "avhuff", "bogus", "cdzs:", "cdzs:abc", ",", "cdzs,,cdzl"]) {
        const out = ctx.tmp("bad.chd");
        const result = compressTo(ctx, ctx.fx(cue), out, ["--codec", codec]);
        ctx.failed(result, { what: `chd --codec ${codec}` });
        check(!ctx.exists(out), `--codec ${codec} left an output`);
      }
    });
  }
  add("compress.chd.cross-format-codec-deflate-rejected", ["compress", "chd", "negative"], (ctx) => {
    // --codec help: "Only the codec names a format actually supports are accepted; there are no cross-format synonyms."
    const out = ctx.tmp("o.chd");
    for (const codec of ["deflate", "lzma2"]) {
      ctx.failed(compressTo(ctx, ctx.fx("exh/cd/data.cue"), out, ["--codec", codec]), { what: `chd --codec ${codec} (another format's codec name)` });
      check(!ctx.exists(out), "left an output");
    }
  });
  for (const [name, cue] of [["cd-data", "exh/cd/data.cue"], ["cd-mixed", "exh/cd/mixed.cue"]]) {
    add(`compress.chd.${name}.byte-parity-with-chdman-per-codec`, ["compress", "chd", "reference", "parity"], (ctx) => {
      needTool("chdman");
      ctx.fx(cue.replace(".cue", ".bin"));
      const identical = [];
      const different = [];
      for (const codec of ["cdzs", "cdlz", "cdzl", "cdfl", "cdlz,cdzl,cdfl"]) {
        const rw = ctx.tmp(`rw-${codec.replace(/,/g, "_")}.chd`);
        const ref = ctx.tmp(`ref-${codec.replace(/,/g, "_")}.chd`);
        ctx.ok(compressTo(ctx, ctx.fx(cue), rw, ["--codec", codec]), `rom-weaver ${codec}`);
        toolMust(toolIn(ctx)("chdman", ["createcd", "-i", ctx.fx(cue), "-o", ref, "-c", codec, "-f"]), `chdman createcd -c ${codec}`);
        const info = (file) => toolMust(toolIn(ctx)("chdman", ["info", "-i", file]), "info").text;
        const field = (text, key) => new RegExp(`^${key}:\\s+(\\S+)`, "m").exec(text)?.[1];
        // Whatever the encoder does, the logical content hashes must agree.
        check(field(info(rw), "Data SHA1") === field(info(ref), "Data SHA1"), `Data SHA1 differs from chdman for ${codec}`);
        (fs.readFileSync(rw).equals(fs.readFileSync(ref)) ? identical : different).push(`${codec}(${fs.statSync(rw).size}/${fs.statSync(ref).size})`);
      }
      ctx.note(`${name}: byte-identical to chdman for [${identical.join(" ")}]; different (rom-weaver/chdman bytes) for [${different.join(" ")}]`);
    });
  }
  add("compress.chd.cue-with-missing-bin", ["compress", "chd", "negative"], (ctx) => {
    const cue = ctx.write("g.cue", 'FILE "missing.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    ctx.failed(compressTo(ctx, cue, ctx.tmp("o.chd")), { what: "cue without bin" });
    check(!ctx.exists(ctx.tmp("o.chd")), "left output");
  });
  add("compress.chd.cue-bin-size-not-sector-multiple", ["compress", "chd", "negative"], (ctx) => {
    ctx.write("g.bin", fs.readFileSync(ctx.fx("exh/cd/data.bin")).subarray(0, 2352 * 10 + 100));
    const cue = ctx.write("g.cue", 'FILE "g.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    const result = compressTo(ctx, cue, ctx.tmp("o.chd"));
    check(!result.panic, "panic");
    if (result.code === 0) ctx.note("bin with a partial last sector accepted by compress chd");
    else check(!ctx.exists(ctx.tmp("o.chd")), "failed run left output");
  });
  add("compress.chd.cue-garbage", ["compress", "chd", "negative"], (ctx) => {
    const cue = ctx.write("g.cue", Buffer.from(prngBytes(300, 4)));
    ctx.failed(compressTo(ctx, cue, ctx.tmp("o.chd")), { what: "garbage cue" });
  });
  add("compress.chd.cue-zero-bytes", ["compress", "chd", "negative"], (ctx) => {
    const cue = ctx.write("g.cue", "");
    ctx.failed(compressTo(ctx, cue, ctx.tmp("o.chd")), { what: "empty cue" });
  });
  add("compress.chd.cue-in-subdirectory-with-spaces", ["compress", "chd", "names"], (ctx) => {
    ctx.write("my dir ☃/game (USA).bin", fs.readFileSync(ctx.fx("exh/cd/data.bin")));
    const cue = ctx.write("my dir ☃/game (USA).cue", 'FILE "game (USA).bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    const out = ctx.tmp("o ☃/game.chd");
    ctx.ok(compressTo(ctx, cue, out), "unicode cue");
    verifyChd(ctx, out, { codec: "x", fxBin: "exh/cd/data.bin", kind: "cd" });
  });
  add("compress.chd.cue-track-edge-cases", ["compress", "chd", "edge"], (ctx) => {
    // pregap / multiple FILE entries / MODE2 are all legal cue syntax; each must either work or fail cleanly
    const bin = fs.readFileSync(ctx.fx("exh/cd/data.bin"));
    ctx.write("a.bin", bin.subarray(0, 2352 * 100));
    ctx.write("b.bin", bin.subarray(2352 * 100, 2352 * 200));
    const variants = {
      "two-files": 'FILE "a.bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 01 00:00:00\nFILE "b.bin" BINARY\n TRACK 02 MODE1/2352\n  INDEX 01 00:00:00\n',
      pregap: 'FILE "a.bin" BINARY\n TRACK 01 MODE1/2352\n  PREGAP 00:02:00\n  INDEX 01 00:00:00\n',
      "index-00": 'FILE "a.bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 00 00:00:00\n  INDEX 01 00:00:10\n',
      "catalog-and-rem": 'REM GENRE x\nCATALOG 1234567890123\nFILE "a.bin" BINARY\n TRACK 01 MODE1/2352\n  INDEX 01 00:00:00\n',
      "crlf-line-endings": 'FILE "a.bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n',
      "mode1-2048": 'FILE "a.bin" BINARY\n TRACK 01 MODE1/2048\n  INDEX 01 00:00:00\n',
      "missing-index": 'FILE "a.bin" BINARY\n TRACK 01 MODE1/2352\n',
    };
    for (const [name, text] of Object.entries(variants)) {
      const cue = ctx.write(`${name}.cue`, text);
      const out = ctx.tmp(`${name}.chd`);
      const result = compressTo(ctx, cue, out);
      check(!result.panic && !result.timedOut, () => `${name}: ${ctx.describe(result)}`);
      if (result.code === 0) {
        needTool("chdman");
        const info = toolIn(ctx)("chdman", ["info", "-i", out]);
        check(info.ok, () => `${name}: chdman cannot read the produced CHD: ${info.text.slice(0, 200)}`);
      } else check(!ctx.exists(out), `${name}: failed run left output`);
      ctx.note(`chd cue variant ${name}: exit ${result.code}`);
    }
  });
  add("compress.chd.dvd-iso", ["compress", "chd", "dvd"], (ctx) => {
    const out = ctx.tmp("o.chd");
    ctx.ok(compressTo(ctx, ctx.fx("exh/dvd/dvd.iso"), out), "iso -> chd");
    needTool("chdman");
    toolMust(toolIn(ctx)("chdman", ["verify", "-i", out]), "chdman verify");
    check(fs.readFileSync(extractPayload(ctx, out)).equals(fs.readFileSync(ctx.fx("exh/dvd/dvd.iso"))), "iso round trip");
    const info = toolIn(ctx)("chdman", ["info", "-i", out]).text;
    ctx.note(`iso -> chd media: ${/Metadata:\s+Tag='(\w+)'/.exec(info)?.[1] ?? "?"}`);
  });
  for (const codec of CHD_RAW_CODECS) {
    for (const level of ["min", "max"]) {
      add(`compress.chd.raw-iso.${codec}.level-${level}`, ["compress", "chd", "levels", codec], (ctx) => {
        const out = ctx.tmp("o.chd");
        const result = compressTo(ctx, ctx.fx("exh/dvd/dvd.iso"), out, ["--codec", codec, "--level", level]);
        ctx.ok(result, `iso chd ${codec}`);
        verifyChd(ctx, out, { codec, fxBin: "exh/dvd/dvd.iso", kind: "raw" });
        check(fs.readFileSync(extractPayload(ctx, out)).equals(fs.readFileSync(ctx.fx("exh/dvd/dvd.iso"))), "round trip");
      });
    }
  }
  add("compress.chd.raw-file-roundtrip", ["compress", "chd", "raw"], (ctx) => {
    const data = textLike(100000);
    const out = ctx.tmp("o.chd");
    ctx.ok(compressTo(ctx, ctx.write("data.bin", data), out), "raw bin -> chd");
    needTool("chdman");
    toolMust(toolIn(ctx)("chdman", ["verify", "-i", out]), "chdman verify");
    check(fs.readFileSync(extractOneFile(ctx, out)).equals(data), "raw chd round trip");
  });
  add("compress.chd.empty-and-one-byte-inputs", ["compress", "chd", "edge"], (ctx) => {
    for (const [name, bytes] of [["empty.bin", Buffer.alloc(0)], ["one.bin", Buffer.from([1])], ["odd.bin", Buffer.from(prngBytes(4097, 8))]]) {
      const out = ctx.tmp(`${name}.chd`);
      const result = compressTo(ctx, ctx.write(name, bytes), out);
      check(!result.panic && !result.timedOut, () => `${name}: ${ctx.describe(result)}`);
      if (result.code === 0) {
        const back = extractAll(ctx, out, `ex-${name}`);
        check(back.length === 1 && fs.readFileSync(back[0]).equals(bytes), `${name}: round trip differs`);
      } else check(!ctx.exists(out), `${name}: failed run left output`);
      ctx.note(`chd of ${name}: exit ${result.code}`);
    }
  });
  add("compress.chd.json-and-stdin", ["compress", "chd", "json"], (ctx) => {
    const out = ctx.tmp("o.chd");
    const doc = ctx.json(ctx.ok(compressTo(ctx, ctx.fx("exh/cd/data.cue"), out, ["--json"]), "chd --json"));
    check(doc.status === "succeeded" && doc.command === "compress", () => JSON.stringify(doc).slice(0, 200));
    ctx.ok(compressTo(ctx, ctx.fx("exh/cd/data.cue"), ctx.tmp("o2.chd"), ["--jsonl"]), "chd --jsonl");
    const stdinOut = ctx.tmp("s.chd");
    ctx.ok(ctx.run(["compress", "-i", "-", "-o", stdinOut, "--stdin-name", "x.iso"], { input: fs.readFileSync(ctx.fx("exh/dvd/dvd.iso")) }), "chd from stdin iso");
    check(fs.readFileSync(extractPayload(ctx, stdinOut, "sx")).equals(fs.readFileSync(ctx.fx("exh/dvd/dvd.iso"))), "stdin chd round trip");
  });
  add("compress.chd.overwrite-policy-and-dry-run", ["compress", "chd", "overwrite"], (ctx) => {
    const out = ctx.write("o.chd", "precious");
    ctx.failed(compressTo(ctx, ctx.fx("exh/cd/data.cue"), out), { message: /overwrite|exists|--force/i, what: "existing chd" });
    check(fs.readFileSync(out, "utf8") === "precious", "changed existing");
    ctx.ok(compressTo(ctx, ctx.fx("exh/cd/data.cue"), out, ["--dry-run", "--force"]), "dry-run --force");
    check(fs.readFileSync(out, "utf8") === "precious", "dry-run modified existing output");
    ctx.ok(compressTo(ctx, ctx.fx("exh/cd/data.cue"), out, ["--force"]), "--force");
    check(fs.statSync(out).size > 1000, "--force output");
  });
  add("compress.chd.multiple-inputs-rejected", ["compress", "chd", "negative"], (ctx) => {
    ctx.failed(ctx.run(["compress", "-i", ctx.fx("exh/cd/data.cue"), "-i", ctx.fx("exh/cd/mixed.cue"), "-o", ctx.tmp("o.chd")]), { what: "two inputs to chd" });
    check(!ctx.exists(ctx.tmp("o.chd")), "left output");
  });
  add("compress.chd.gdi-input", ["compress", "chd", "gdi"], (ctx) => {
    const bin = fs.readFileSync(ctx.fx("exh/cd/data.bin"));
    ctx.write("track01.bin", bin.subarray(0, 2352 * 100));
    ctx.write("track02.bin", bin.subarray(2352 * 100, 2352 * 200));
    const gdi = ctx.write("disc.gdi", "2\n1 0 4 2352 track01.bin 0\n2 450 4 2352 track02.bin 0\n");
    const out = ctx.tmp("o.chd");
    const result = compressTo(ctx, gdi, out);
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
    if (result.code === 0) {
      needTool("chdman");
      toolMust(toolIn(ctx)("chdman", ["info", "-i", out]), "chdman info gdi chd");
    } else check(!ctx.exists(out), "failed gdi run left output");
    ctx.note(`gdi -> chd exit ${result.code}: ${result.all.trim().split("\n")[0].slice(0, 140)}`);
  });

  // ================================================================== RVZ
  const gcIso = "reference/gc/disc.iso";
  const verifyRvz = (ctx, rvz, iso = gcIso) => {
    needTool("dolphin-tool");
    const v = toolIn(ctx)("dolphin-tool", ["verify", "-i", rvz, "-a", "crc32"]);
    ctx.note(`dolphin-tool verify exit ${v.code}`);
    const back = ctx.tmp("dolphin-back.iso");
    toolMust(toolIn(ctx)("dolphin-tool", ["convert", "-i", rvz, "-o", back, "-f", "iso"]), "dolphin-tool convert rvz -> iso");
    ctx.same(back, ctx.fx(iso), "dolphin-tool decode of rom-weaver rvz");
    const rw = ctx.tmp("rw-back/disc.iso");
    ctx.ok(ctx.run(["extract", rvz, "-o", path.dirname(rw), "--force"]), "rom-weaver extract rvz");
    ctx.same(extractOneFile(ctx, rvz, "rw-back2"), ctx.fx(iso), "rom-weaver decode of rvz");
  };
  for (const level of [...LEVELS, "default"]) {
    add(`compress.rvz.zstd.level-${level}`, ["compress", "rvz", "levels"], (ctx) => {
      const out = ctx.tmp("o.rvz");
      ctx.ok(compressTo(ctx, ctx.fx(gcIso), out, ["--codec", "zstd", ...(level === "default" ? [] : ["--level", level])]), `rvz ${level}`);
      verifyRvz(ctx, out);
    });
  }
  add("compress.rvz.codec-colon-level", ["compress", "rvz", "levels"], (ctx) => {
    for (const lvl of ["1", "5", "22", "-5"]) {
      const out = ctx.tmp(`c${lvl}.rvz`);
      const result = compressTo(ctx, ctx.fx(gcIso), out, ["--codec", `zstd:${lvl}`]);
      if (result.code === 0) verifyRvz(ctx, out);
      else {
        ctx.failed(result, { what: `zstd:${lvl}` });
        ctx.note(`rvz zstd:${lvl} rejected: ${ctx.describe(result)}`);
      }
    }
  });
  for (const size of [32768, 65536, 131072, 262144, 2097152, 33554432]) {
    add(`compress.rvz.block-size-${size}`, ["compress", "rvz", "blocksize"], (ctx) => {
      const out = ctx.tmp("o.rvz");
      ctx.ok(compressTo(ctx, ctx.fx(gcIso), out, ["--rvz-block-size", String(size), "--level", "low"]), `block size ${size}`);
      verifyRvz(ctx, out);
    });
  }
  for (const size of ["0", "1", "1000", "16384", "49152", "65535", "2147483648", "abc", "-32768", "131072.5", "1GiB"]) {
    add(`compress.rvz.invalid-block-size-${size}`, ["compress", "rvz", "negative"], (ctx) => {
      const out = ctx.tmp("o.rvz");
      const result = compressTo(ctx, ctx.fx(gcIso), out, ["--rvz-block-size", size]);
      if (size === "1GiB") {
        ctx.note(`--rvz-block-size 1GiB -> exit ${result.code}`);
        check(!result.panic, "panic");
        return;
      }
      ctx.failed(result, { what: `--rvz-block-size ${size}` });
      check(!ctx.exists(out), "left output");
    });
  }
  add("compress.rvz.block-size-1gib-boundary", ["compress", "rvz", "blocksize"], (ctx) => {
    const out = ctx.tmp("o.rvz");
    const result = compressTo(ctx, ctx.fx(gcIso), out, ["--rvz-block-size", "1073741824", "--level", "min"]);
    check(!result.panic, "panic");
    if (result.code === 0) verifyRvz(ctx, out);
    else ctx.note(`block size 1 GiB rejected: ${ctx.describe(result)}`);
  });
  add("compress.rvz.block-size-on-non-rvz-format", ["compress", "rvz", "negative"], (ctx) => {
    const result = compressTo(ctx, ctx.fx("rom/base.bin"), ctx.tmp("o.zip"), ["--rvz-block-size", "65536"]);
    check(!result.panic, "panic");
    ctx.note(`--rvz-block-size on a zip: exit ${result.code}`);
  });
  for (const bad of ["lzma", "deflate", "bogus", "store"]) {
    add(`compress.rvz.invalid-codec-${bad}`, ["compress", "rvz", "negative"], (ctx) => {
      const out = ctx.tmp("o.rvz");
      ctx.failed(compressTo(ctx, ctx.fx(gcIso), out, ["--codec", bad]), { what: `rvz --codec ${bad}` });
      check(!ctx.exists(out), "left output");
    });
  }
  add("compress.rvz.threads-parity", ["compress", "rvz", "threads"], (ctx) => {
    const bytes = {};
    for (const j of ["1", "4", "auto"]) {
      const out = ctx.tmp(`j${j}/o.rvz`);
      ctx.ok(compressTo(ctx, ctx.fx(gcIso), out, ["-j", j, "--level", "low"]), `-j ${j}`);
      bytes[j] = fs.readFileSync(out);
    }
    check(bytes["1"].equals(bytes["4"]) && bytes["1"].equals(bytes.auto), "RVZ bytes differ between -j values");
  });
  add("compress.rvz.non-disc-input-rejected", ["compress", "rvz", "negative"], (ctx) => {
    const out = ctx.tmp("o.rvz");
    ctx.failed(compressTo(ctx, ctx.fx("rom/base.bin"), out), { what: "non-disc to rvz" });
    check(!ctx.exists(out), "left output");
    ctx.failed(compressTo(ctx, ctx.write("empty.iso", ""), out), { what: "empty to rvz" });
    check(!ctx.exists(out), "left output (empty)");
    ctx.failed(compressTo(ctx, ctx.write("junk.iso", prngBytes(4096, 6)), out), { what: "random .iso to rvz" });
    check(!ctx.exists(out), "left output (random .iso)");
  });
  add("compress.rvz.truncated-disc-body", ["compress", "rvz", "edge"], (ctx) => {
    const out = ctx.tmp("o.rvz");
    const cut = ctx.write("cut.iso", fs.readFileSync(ctx.fx(gcIso)).subarray(0, 0x300000));
    const result = compressTo(ctx, cut, out);
    check(!result.panic && !result.timedOut, () => ctx.describe(result));
    if (result.code === 0) {
      const back = extractOneFile(ctx, out);
      check(fs.readFileSync(back).equals(fs.readFileSync(cut)), "rvz of a cut-off disc does not round trip");
    } else check(!ctx.exists(out), "failed run left output");
    ctx.note(`rvz of a truncated GC iso: exit ${result.code}`);
  });
  add("compress.rvz.json-stdin-overwrite", ["compress", "rvz", "json"], (ctx) => {
    const out = ctx.tmp("o.rvz");
    const doc = ctx.json(ctx.ok(compressTo(ctx, ctx.fx(gcIso), out, ["--json", "--level", "min"]), "rvz --json"));
    check(doc.status === "succeeded" && doc.details?.emitted_files?.[0]?.size_bytes === fs.statSync(out).size, () => JSON.stringify(doc).slice(0, 300));
    ctx.failed(compressTo(ctx, ctx.fx(gcIso), out), { message: /overwrite|exists|--force/i, what: "existing rvz" });
    ctx.ok(ctx.run(["compress", "-i", "-", "-o", ctx.tmp("s.rvz"), "--stdin-name", "disc.iso", "--level", "min"], { input: fs.readFileSync(ctx.fx(gcIso)) }), "rvz from stdin");
    verifyRvz(ctx, ctx.tmp("s.rvz"));
  });

  // ================================================================== Z3DS
  const ctrInputs = [
    ["3ds", "exh/ctr/game.3ds", "z3ds"],
    ["cci", "exh/ctr/game.cci", "zcci"],
    ["cxi", "exh/ctr/game.cxi", "zcxi"],
  ];
  const zstdPayload = (ctx, z3ds) => {
    // Z3DS = 0x20-byte header, metadata, then a (seekable) zstd stream.
    const bytes = fs.readFileSync(z3ds);
    check(bytes.subarray(0, 4).toString("latin1") === "Z3DS", "missing Z3DS magic");
    const headerSize = bytes.readUInt16LE(0xa);
    const metaSize = bytes.readUInt32LE(0xc);
    const payload = ctx.write("z3ds-payload.zst", bytes.subarray(headerSize + metaSize));
    return payload;
  };
  for (const [kind, src, zext] of ctrInputs) {
    for (const level of [...LEVELS, "default"]) {
      add(`compress.z3ds.${kind}.zstd.level-${level}`, ["compress", "z3ds", "levels"], (ctx) => {
        const input = ctx.write(`game.${kind}`, fs.readFileSync(ctx.fx(src)));
        const out = ctx.tmp(`game.${zext}`);
        ctx.ok(compressTo(ctx, input, out, ["--codec", "zstd", ...(level === "default" ? [] : ["--level", level])]), `z3ds ${level}`);
        const back = extractOneFile(ctx, out);
        check(fs.readFileSync(back).equals(fs.readFileSync(input)), "z3ds round trip differs");
        if (path.extname(back) !== `.${kind}`) ctx.note(`z3ds of .${kind} extracts as ${path.basename(back)}`);
        if (level === "default" || level === "max") {
          needTool("zstd");
          const payload = zstdPayload(ctx, out);
          const dec = ctx.tmp("zstd-dec.bin");
          toolMust(toolIn(ctx)("zstd", ["-d", "-q", "-f", payload, "-o", dec]), "zstd -d of the Z3DS payload");
          ctx.same(dec, input, "zstd tool decode of the Z3DS payload");
        }
      });
    }
  }
  add("compress.z3ds.invalid-codecs-levels", ["compress", "z3ds", "negative"], (ctx) => {
    const input = ctx.write("game.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    for (const args of [["--codec", "lzma"], ["--codec", "deflate"], ["--codec", "store"], ["--level", "ultra"], ["--codec", "zstd:abc"], ["-j", "0"]]) {
      const out = ctx.tmp("bad.z3ds");
      ctx.failed(compressTo(ctx, input, out, args), { what: `z3ds ${args.join(" ")}` });
      check(!ctx.exists(out), `${args.join(" ")} left output`);
    }
  });
  add("compress.z3ds.output-extension-mapping", ["compress", "z3ds", "names"], (ctx) => {
    const input = ctx.write("game.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    for (const ext of ["z3ds", "zcci", "zcxi", "zcia", "z3dsx"]) {
      const out = ctx.tmp(`o.${ext}`);
      const result = compressTo(ctx, input, out, ["--level", "min"]);
      check(!result.panic, `${ext}: panic`);
      if (result.code === 0) {
        const back = extractOneFile(ctx, out, `ex-${ext}`);
        check(fs.readFileSync(back).equals(fs.readFileSync(input)), `${ext}: round trip`);
        ctx.note(`NCSD input to .${ext}: ok (extracts as ${path.extname(back)})`);
      } else {
        ctx.failed(result, { what: ext });
        ctx.note(`NCSD input to .${ext}: rejected (${result.all.trim().split("\n")[0].slice(0, 100)})`);
      }
    }
  });
  add("compress.z3ds.non-3ds-input", ["compress", "z3ds", "negative"], (ctx) => {
    const out = ctx.tmp("o.z3ds");
    const result = compressTo(ctx, ctx.fx("rom/base.bin"), out);
    check(!result.panic, "panic");
    if (result.code === 0) {
      check(/warn/i.test(result.all), "non-3DS input accepted without a warning");
      check(fs.readFileSync(extractOneFile(ctx, out)).equals(fs.readFileSync(ctx.fx("rom/base.bin"))), "round trip of non-3DS content");
    } else check(!ctx.exists(out), "failed run left output");
    const empty = compressTo(ctx, ctx.write("e.3ds", ""), ctx.tmp("e.z3ds"));
    check(!empty.panic, "empty input panic");
    ctx.note(`z3ds of empty .3ds: exit ${empty.code}`);
  });
  add("compress.z3ds.threads-parity", ["compress", "z3ds", "threads"], (ctx) => {
    const input = ctx.write("game.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    const bytes = {};
    for (const j of ["1", "4", "auto"]) {
      const out = ctx.tmp(`j${j}/o.z3ds`);
      ctx.ok(compressTo(ctx, input, out, ["-j", j]), `-j ${j}`);
      bytes[j] = fs.readFileSync(out);
    }
    check(bytes["1"].equals(bytes["4"]) && bytes["1"].equals(bytes.auto), "Z3DS bytes differ between -j values");
  });
  add("compress.z3ds.json-stdin-overwrite", ["compress", "z3ds", "json"], (ctx) => {
    const input = ctx.write("game.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    const out = ctx.tmp("o.z3ds");
    const doc = ctx.json(ctx.ok(compressTo(ctx, input, out, ["--json"]), "--json"));
    check(doc.status === "succeeded", () => JSON.stringify(doc).slice(0, 200));
    ctx.failed(compressTo(ctx, input, out), { message: /overwrite|exists|--force/i, what: "existing z3ds" });
    const viaStdin = ctx.tmp("s.z3ds");
    ctx.ok(ctx.run(["compress", "-i", "-", "-o", viaStdin, "--stdin-name", "game.3ds"], { input: fs.readFileSync(input) }), "z3ds from stdin");
    check(fs.readFileSync(extractOneFile(ctx, viaStdin)).equals(fs.readFileSync(input)), "stdin z3ds round trip");
  });
  add("compress.z3ds.multiple-inputs-rejected", ["compress", "z3ds", "negative"], (ctx) => {
    const a = ctx.write("a.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    const b = ctx.write("b.3ds", fs.readFileSync(ctx.fx("exh/ctr/game.3ds")));
    ctx.failed(ctx.run(["compress", "-i", a, "-i", b, "-o", ctx.tmp("o.z3ds")]), { what: "two inputs" });
  });

  // ================================================================== > 4 GiB sparse input (zip64 / 64-bit sizes)
  const SPARSE = 4400 * 1024 * 1024;
  const sparseFile = (ctx) => {
    const file = ctx.tmp("big.bin");
    const fd = fs.openSync(file, "w");
    fs.ftruncateSync(fd, SPARSE);
    fs.writeSync(fd, Buffer.from("HEAD"), 0, 4, 0);
    fs.writeSync(fd, Buffer.from("TAIL"), 0, 4, SPARSE - 4);
    fs.writeSync(fd, Buffer.from("MID!"), 0, 4, 0x1_0000_0000 + 17); // beyond the 32-bit boundary
    fs.closeSync(fd);
    return file;
  };
  for (const [fmt, codec] of [["zip", "deflate"], ["zip", "zstd"], ["7z", "lzma2"]]) {
    add(`compress.large.${fmt}-${codec}.4400-mib-sparse-roundtrip`, ["compress", "large", fmt, codec], (ctx) => {
      const input = sparseFile(ctx);
      const out = ctx.tmp(`big.${fmt}`);
      ctx.ok(compressTo(ctx, input, out, ["--codec", codec, "--level", "low"]), `${fmt} ${codec} of a 4.4 GiB file`);
      const back = ctx.tmp("back");
      ctx.ok(ctx.run(["extract", "--input", out, "--output", back]), "extract");
      const files = filesUnder(back);
      check(files.length === 1 && fs.statSync(files[0]).size === SPARSE, () => `extracted ${files.map((f) => `${path.basename(f)}:${fs.statSync(f).size}`)}`);
      const cmp = toolIn(ctx)("cmp", ["-s", input, files[0]]);
      check(cmp.ok, "4.4 GiB round trip differs (cmp)");
      const tool = fmt === "zip" ? ["unzip", ["-tq", out]] : ["7z", ["t", out]];
      if (codec !== "zstd") {
        needTool(tool[0]);
        toolMust(toolIn(ctx)(tool[0], tool[1]), `${tool[0]} test of the >4 GiB archive`);
      }
    });
  }

  // ================================================================== generic / cross format
  add("compress.format.unwritable-formats-rejected", ["compress", "negative"], (ctx) => {
    const input = ctx.write("game.bin", textLike(2000));
    for (const ext of ["tar", "tar.gz", "gz", "xz", "zst", "rar", "cso", "wia", "gcz", "nfs", "xiso", "pbp", "bz2", "lz4", "tgc", "wbfs", "foo", ""]) {
      const out = ctx.tmp(`unwritable${ext ? `.${ext}` : ""}`);
      const result = compressTo(ctx, input, out);
      ctx.failed(result, { what: `compress to .${ext}` });
      check(!ctx.exists(out), `.${ext}: left an output`);
    }
    for (const fmt of ["tar", "gz", "rar", "wia", "cso", "bogus"]) {
      const out = ctx.tmp("x.out");
      ctx.failed(ctx.run(["compress", "-i", input, "-o", out, "-f", fmt]), { what: `-f ${fmt}` });
      check(!ctx.exists(out), `-f ${fmt}: left an output`);
    }
  });
  add("compress.format.alias-spellings", ["compress", "format"], (ctx) => {
    const input = ctx.write("game.bin", textLike(2000));
    for (const [alias, magic] of [["7zip", "7z"], ["ZIP", "PK"], ["7Z", "7z"], ["Zip", "PK"]]) {
      const out = ctx.tmp(`a-${alias}.out`);
      const result = ctx.run(["compress", "-i", input, "-o", out, "-f", alias]);
      if (result.code !== 0) {
        ctx.failed(result, { what: `-f ${alias}` });
        ctx.note(`-f ${alias} rejected: ${ctx.describe(result)}`);
        continue;
      }
      check(fs.readFileSync(out).subarray(0, 2).toString("latin1") === magic, `-f ${alias} wrote the wrong container`);
    }
  });
  add("compress.input.missing-and-directory-and-none", ["compress", "negative"], (ctx) => {
    ctx.failed(compressTo(ctx, ctx.tmp("missing.bin"), ctx.tmp("o.zip")), { what: "missing input" });
    ctx.failed(ctx.run(["compress", "--output", ctx.tmp("o.zip")]), { what: "no input" });
    ctx.failed(ctx.run(["compress", "--input", ctx.write("a.bin", "x")]), { what: "no output" });
    check(!ctx.exists(ctx.tmp("o.zip")), "left output");
  });
  add("compress.input.same-as-output", ["compress", "negative"], (ctx) => {
    const data = textLike(2000);
    const file = ctx.write("same.zip", data);
    const result = compressTo(ctx, file, file, ["--force"]);
    check(!result.panic, "panic");
    ctx.note(`compress onto its own input with --force: exit ${result.code}; input ${fs.readFileSync(file).equals(data) ? "unchanged" : "CHANGED"}`);
    if (result.code !== 0) check(fs.readFileSync(file).equals(data), "failed run destroyed the input file");
  });
  add("compress.output.parent-directory-missing-is-created-or-rejected", ["compress", "edge"], (ctx) => {
    const out = ctx.tmp("nope/deeper/o.zip");
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    const result = compressTo(ctx, ctx.write("a.bin", "x"), out);
    check(!result.panic, "panic");
    if (result.code === 0) check(ctx.exists(out), "exit 0 without output");
    ctx.note(`output below a missing directory: exit ${result.code}`);
  });
  add("compress.output.is-a-directory", ["compress", "negative"], (ctx) => {
    fs.mkdirSync(ctx.tmp("adir.zip"));
    const result = compressTo(ctx, ctx.write("a.bin", "x"), path.join(ctx.work, "adir.zip"), ["--force"]);
    ctx.failed(result, { what: "output is a directory" });
  });
  add("compress.output.read-only-directory", ["compress", "negative"], (ctx) => {
    if (process.getuid?.() === 0) skip("root ignores directory permissions");
    const dir = ctx.tmp("ro");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o555);
    try {
      const result = compressTo(ctx, ctx.write("a.bin", "x"), path.join(dir, "o.zip"));
      ctx.failed(result, { what: "read-only output dir" });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
  add("compress.verify.7z-tool-reads-rom-weaver-7z-with-all-levels-listing", ["compress", "7z", "reference"], (ctx) => {
    needTool("7z");
    const input = ctx.write("a.bin", textLike(50000));
    const out = ctx.tmp("o.7z");
    ctx.ok(compressTo(ctx, input, out), "7z");
    const listing = toolMust(toolIn(ctx)("7z", ["l", "-slt", out]), "7z l").text;
    check(/Method = LZMA2/.test(listing), () => `7z method is not LZMA2:\n${listing.slice(-400)}`);
  });
  add("compress.verify.zip-methods-by-codec", ["compress", "zip", "reference"], (ctx) => {
    needTool("7z");
    const input = ctx.write("a.bin", textLike(50000));
    for (const [codec, method] of [["store", /Method = Store/], ["deflate", /Method = Deflate/], ["zstd", /Method = (ZSTD|zstd|93)/i]]) {
      const out = ctx.tmp(`${codec}.zip`);
      ctx.ok(compressTo(ctx, input, out, ["--codec", codec]), codec);
      const listing = toolIn(ctx)("7z", ["l", "-slt", out]).text;
      if (!method.test(listing)) {
        if (codec === "zstd") ctx.note(`7z lists the zstd zip as: ${/Method = .*/.exec(listing)?.[0] ?? listing.slice(-120)}`);
        else fail(`zip --codec ${codec}: 7z reports ${/Method = .*/.exec(listing)?.[0] ?? "no method"}`);
      }
    }
  });
};
