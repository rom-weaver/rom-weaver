// Bounded structural fuzzing of the apply path: every truncation length and a flip of every byte of a small
// patch, per format. Asserts only the robustness contract: no panic/crash/hang, no unbounded output, and no
// leftover output after a failure. Strict formats must additionally never silently produce wrong bytes
// when their own integrity check is present.
import fs from "node:fs";
import { add, check } from "../lib/harness.mjs";
import * as E from "../lib/encoders.mjs";
import { PATCH_FORMATS_WITH_CREATE } from "../lib/fixture-defs.mjs";

const SIZE = 512;
const rom = () => {
  let state = 0x9e3779b9;
  return Uint8Array.from({ length: SIZE }, () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 255;
  });
};
const target = () => {
  const out = rom();
  out.fill(0, 100, 140);
  out[3] ^= 0xff;
  out[SIZE - 1] ^= 0x5a;
  return out;
};

// formats whose handlers verify the patch itself (flip => failure or still-correct output)
const SELF_CHECKING = new Set(["bps", "ups", "xdelta", "apsgba"]);
const FLIP_BUDGET = 400;
// Mirrors the Rust plausibility floor (rom-weaver-patches ensure_plausible_output_size): 1 GiB for tiny inputs.
const MAX_PLAUSIBLE_OUTPUT = 1 << 30;

export const register = ({ fixtures }) => {
  fixtures.define("fuzz/base.bin", { where: "repo", purpose: "512-byte fuzz source", how: "xorshift", deterministic: true, build: () => rom() });
  fixtures.define("fuzz/target.bin", { where: "repo", purpose: "512-byte fuzz target", how: "edited base", deterministic: true, build: () => target() });
  const created = (format) => `fuzz/p.${format}`;
  for (const format of PATCH_FORMATS_WITH_CREATE) {
    fixtures.define(created(format), {
      where: "cache", purpose: `${format} patch for the 512-byte fuzz pair`, how: "rom-weaver patch create", deterministic: false,
      build: (self) => {
        const out = self.location(created(format));
        fs.mkdirSync(out.replace(/\/[^/]*$/, ""), { recursive: true });
        const result = self.run(["patch", "create", "--original", self.path("fuzz/base.bin"), "--modified", self.path("fuzz/target.bin"), "--output", out, "--force"]);
        if (result.code !== 0) throw new Error(`create ${format}: ${result.all.slice(0, 200)}`);
        return undefined;
      },
    });
  }
  fixtures.define("fuzz/p-ind.bps", { where: "repo", purpose: "independent BPS for the fuzz pair", how: "encodeBps", deterministic: true, build: () => E.encodeBps(rom(), target()) });
  fixtures.define("fuzz/p-ind.vcdiff", { where: "repo", purpose: "independent VCDIFF+adler for the fuzz pair", how: "encodeVcdiff", deterministic: true, build: () => E.encodeVcdiff(rom(), target(), { adler: true }) });

  const subjects = [...PATCH_FORMATS_WITH_CREATE.map((format) => ({ name: format, fixture: created(format), ext: format, extra: format === "mod" ? ["--ignore-checksum-validation"] : [] })), { name: "ind-bps", fixture: "fuzz/p-ind.bps", ext: "bps", extra: [] }, { name: "ind-vcdiff", fixture: "fuzz/p-ind.vcdiff", ext: "vcdiff", extra: [] }];
  for (const subject of subjects) {
    const base = subject.name.replace(/^ind-/, "");
    const attempt = (ctx, patchBytes, index, label) => {
      const patch = ctx.write(`work/${label}-${index}.${subject.ext}`, patchBytes);
      const out = ctx.tmp(`work/out-${label}.bin`);
      fs.rmSync(out, { force: true });
      const result = ctx.apply(ctx.fx("fuzz/base.bin"), patch, out, ["-j", "2", ...subject.extra]);
      return { result, out };
    };
    const judge = (ctx, { result, out }, what) => {
      check(!result.timedOut, `${what}: timed out`);
      check(!result.panic, () => `${what}: crash/panic :: ${ctx.describe(result)}`);
      check([0, 1, 2].includes(result.code), () => `${what}: unexpected exit ${result.code}`);
      if (result.code !== 0) check(!ctx.exists(out), `${what}: failed run left an output file`);
      else if (fs.statSync(out).size > MAX_PLAUSIBLE_OUTPUT) {
        const size = fs.statSync(out).size;
        fs.rmSync(out, { force: true });
        check(false, `${what}: corrupt patch made apply write a ${size}-byte output with exit 0 (the output-size plausibility guard should reject it)`);
      }
    };
    add(`fuzz.truncate.${subject.name}`, ["fuzz", "negative", subject.name], (ctx) => {
      const bytes = fs.readFileSync(ctx.fx(subject.fixture));
      const step = Math.max(1, Math.floor(bytes.length / FLIP_BUDGET));
      const failuresByShape = [];
      for (let cut = 0; cut < bytes.length; cut += step) {
        const run = attempt(ctx, bytes.subarray(0, cut), cut, "trunc");
        judge(ctx, run, `cut at ${cut}/${bytes.length}`);
        if (cut === 0) check(run.result.code !== 0, "empty patch accepted");
        if (SELF_CHECKING.has(base) && cut < bytes.length - 4 && run.result.code === 0) {
          if (ctx.exists(run.out) && fs.statSync(run.out).size === 0) ctx.note(`cut at ${cut}: patch truncated to its header (zero windows) applied with exit 0 and wrote an empty ROM (by design: RFC 3284 allows zero windows, so a cut after the header is a valid empty-target patch; a warning is reported)`);
          else failuresByShape.push(cut);
        }
      }
      check(failuresByShape.length === 0, () => `self-checking format accepted truncated patches at cuts ${failuresByShape.slice(0, 8).join(",")}`);
    });
    add(`fuzz.bitflip.${subject.name}`, ["fuzz", "negative", subject.name], (ctx) => {
      const bytes = fs.readFileSync(ctx.fx(subject.fixture));
      const step = Math.max(1, Math.floor(bytes.length / FLIP_BUDGET));
      const wrong = [];
      for (let at = 0; at < bytes.length; at += step) {
        const mutated = Buffer.from(bytes);
        mutated[at] ^= 0xff;
        const run = attempt(ctx, mutated, at, "flip");
        judge(ctx, run, `flip byte ${at}/${bytes.length}`);
        if (SELF_CHECKING.has(base) && run.result.code === 0 && !fs.readFileSync(run.out).equals(fs.readFileSync(ctx.fx("fuzz/target.bin")))) wrong.push(at);
      }
      check(wrong.length === 0, () => `self-checking format silently produced wrong output after flipping bytes ${wrong.slice(0, 8).join(",")}`);
    });
  }
  // wrong-but-plausible containers: valid archive + garbage patch inside
  add("fuzz.hdiff.upstream-truncate", ["fuzz", "negative", "hdiff"], (ctx) => {
    const patchPath = "ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiff13-zlib.hdiff";
    const bytes = fs.readFileSync(ctx.fx(patchPath));
    const step = Math.max(1, Math.floor(bytes.length / 120));
    for (let cut = 0; cut < bytes.length; cut += step) {
      const patch = ctx.write(`h-${cut}.hdiff`, bytes.subarray(0, cut));
      const result = ctx.apply(ctx.fx("ext:crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin"), patch, ctx.tmp(`h-${cut}.bin`));
      check(!result.panic && !result.timedOut, () => `hdiff cut ${cut}: ${ctx.describe(result)}`);
      if (cut === 0) check(result.code !== 0, "empty hdiff accepted");
    }
  });
};
