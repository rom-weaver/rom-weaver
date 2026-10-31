// WIA and GCZ inputs written by the reference writer (dolphin-tool): extract / patch-apply parity with the
// original ISO and with dolphin-tool's own reader, over the writer's option space, plus damaged containers.
import fs from "node:fs";
import path from "node:path";
import { add, check, sameBytes, sha256 } from "../lib/harness.mjs";
import * as E from "../lib/encoders.mjs";
import { describeTool, extractOne, filesUnder, needTool, prngBytes, runTool, toolIn, toolMust } from "../lib/reference-tools.mjs";

const MIB = 1024 * 1024;
const DISC_SIZE = 5 * MIB + 0x1800; // not a multiple of any chunk size
const DISC = "reference/gc/disc.iso";
const TARGET = "reference/gc/target.iso";

/**
 * Deterministic GameCube-like image: GC magic, apploader-ish random block, a DOL slot, a real two-entry FST
 * (dolphin-tool refuses images without a parsable file system), random file data, a zero run and a repeated-byte run.
 */
const buildDisc = () => {
  const bytes = new Uint8Array(DISC_SIZE);
  const text = (value, at) => bytes.set(Buffer.from(value, "latin1"), at);
  text("RWTEST", 0);
  bytes.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  text("rom-weaver-reference-disc", 0x20);
  const view = new DataView(bytes.buffer);
  const dol = 0x20000;
  const fst = 0x30000;
  const fstBytes = new Uint8Array(12 * 2 + 6);
  const fstView = new DataView(fstBytes.buffer);
  fstView.setUint32(0, 0x01000000);
  fstView.setUint32(8, 2); // root: two entries
  fstView.setUint32(12, 0); // file entry: name offset 0
  fstView.setUint32(16, 0x40000);
  fstView.setUint32(20, 0x1000);
  fstBytes.set(Buffer.from("a.bin\0", "latin1"), 24);
  bytes.set(fstBytes, fst);
  view.setUint32(0x420, dol);
  view.setUint32(0x424, fst);
  view.setUint32(0x428, fstBytes.length);
  view.setUint32(0x42c, fstBytes.length);
  bytes.set(prngBytes(0x2000, 0x11), 0x2440);
  bytes.set(prngBytes(0x1000, 0x22), dol);
  bytes.set(prngBytes(0x1000, 0x33), 0x40000);
  bytes.set(prngBytes(0x20000, 0x44), 0x300000);
  bytes.fill(0xaa, 0x100000, 0x110000);
  bytes.set(prngBytes(0x200, 0x55), DISC_SIZE - 0x200);
  return bytes;
};
const buildTarget = () => {
  const out = buildDisc();
  for (const at of [0x2500, 0x20010, 0x40100, 0x300100, 0x310000, DISC_SIZE - 1]) out[at] ^= 0xff;
  out.fill(0x5a, 0x104000, 0x104100);
  return out;
};

// [id, dolphin-tool convert flags]. WIA chunks must be a multiple of 2 MiB; dolphin-tool's -c accepts none, bzip2,
// lzma, lzma2 (zstd is RVZ-only; "purge" has no CLI spelling) and -l 1..9 for the last three.
const WIA = [
  ["none-bs2m", ["-b", String(2 * MIB), "-c", "none"]],
  ["none-bs4m", ["-b", String(4 * MIB), "-c", "none"]],
  ["none-bs8m", ["-b", String(8 * MIB), "-c", "none"]],
  ...["bzip2", "lzma", "lzma2"].flatMap((codec) => [1, 5, 9].map((level) => [`${codec}-l${level}-bs2m`, ["-b", String(2 * MIB), "-c", codec, "-l", String(level)]])),
  ["bzip2-l5-bs4m", ["-b", String(4 * MIB), "-c", "bzip2", "-l", "5"]],
  ["lzma-l5-bs8m", ["-b", String(8 * MIB), "-c", "lzma", "-l", "5"]],
  ["lzma2-l5-bs4m", ["-b", String(4 * MIB), "-c", "lzma2", "-l", "5"]],
  ["lzma2-l9-bs8m", ["-b", String(8 * MIB), "-c", "lzma2", "-l", "9"]],
  ["none-scrub", ["-b", String(2 * MIB), "-c", "none", "-s"]],
  ["lzma2-l5-scrub", ["-b", String(2 * MIB), "-c", "lzma2", "-l", "5", "-s"]],
];
// GCZ blocks: dolphin-tool accepts any block size; 32 KiB and up is what the Dolphin GUI offers.
const GCZ = [...[32768, 65536, 131072, 262144, MIB, 2 * MIB, 4 * MIB].map((size) => [`bs${size / 1024}k`, ["-b", String(size)]]), ["bs32k-scrub", ["-b", "32768", "-s"]], ["bs64k-scrub", ["-b", "65536", "-s"]]];
// Smaller blocks that dolphin-tool also writes and reads back (its reader is not limited to a 32 KiB sector multiple).
const GCZ_SMALL = [["bs16k", 16384], ["bs8k", 8192], ["bs4k", 4096], ["bs2k", 2048]];

const fixtureName = (kind, id) => `reference/gc/${kind}/${id}.${kind}`;

export const register = ({ fixtures }) => {
  const define = (name, purpose, how, build, deterministic = true) => fixtures.define(name, { where: "cache", purpose, how, deterministic, build });
  define(DISC, "5 MiB GameCube-like ISO (GC magic, FST, random/zero/repeated regions)", "cases/reference-disc.mjs buildDisc()", buildDisc);
  define(TARGET, "GameCube-like ISO with edits in apploader, DOL, file data and the tail", "buildDisc() + 6 byte flips and a 0x5a run", buildTarget);
  define("reference/gc/disc.ips", "IPS patch disc.iso -> target.iso", "encodeIps", () => E.encodeIps(fixtures.bytes(DISC), fixtures.bytes(TARGET)));
  define("reference/gc/disc.bps", "BPS patch disc.iso -> target.iso", "encodeBps", () => E.encodeBps(fixtures.bytes(DISC), fixtures.bytes(TARGET)));

  const convertFixture = (kind, id, flags) =>
    define(
      fixtureName(kind, id),
      `${kind.toUpperCase()} of disc.iso written by dolphin-tool convert ${flags.join(" ")}`,
      `dolphin-tool convert -f ${kind} ${flags.join(" ")}`,
      (self) => {
        const out = self.location(fixtureName(kind, id));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.mkdirSync(self.cacheDir, { recursive: true });
        const user = fs.mkdtempSync(path.join(self.cacheDir, ".dolphin-user-"));
        try {
          fs.rmSync(out, { force: true });
          const result = runTool("dolphin-tool", ["convert", "-u", path.join(user, "u"), "-i", self.path(DISC), "-o", out, "-f", kind, ...flags], { home: user });
          if (!result.ok || !fs.existsSync(out)) throw new Error(`dolphin-tool convert failed: ${describeTool(result)}`);
        } finally {
          fs.rmSync(user, { recursive: true, force: true });
        }
        return undefined;
      },
      false,
    );
  for (const [id, flags] of WIA) convertFixture("wia", id, flags);
  for (const [id, flags] of GCZ) convertFixture("gcz", id, flags);
  for (const [id, size] of GCZ_SMALL) convertFixture("gcz", id, ["-b", String(size)]);

  /** dolphin-tool convert -f iso: the reference reader's view of the container. */
  const dolphinIso = (ctx, input, name = "dolphin.iso") => {
    const out = ctx.tmp(`dolphin/${name}`);
    const tool = toolIn(ctx);
    toolMust(tool("dolphin-tool", ["convert", "-u", ctx.tmp("dolphin/user"), "-i", input, "-o", out, "-f", "iso"]), `dolphin-tool convert -f iso ${path.basename(input)}`);
    check(fs.existsSync(out), "dolphin-tool wrote no ISO");
    return out;
  };

  const discCase = (kind, id, { scrub = false } = {}) => {
    add(`reference.${kind}.${id}.extract-and-apply`, ["reference", kind, "disc", "dolphin-tool"], (ctx) => {
      needTool("dolphin-tool");
      const container = ctx.fx(fixtureName(kind, id));
      const original = ctx.fx(DISC);
      const viaDolphin = dolphinIso(ctx, container);
      if (!scrub) ctx.same(viaDolphin, original, "dolphin-tool round trip of the fixture (fixture sanity)");
      const extracted = extractOne(ctx, container);
      // (a) the original ISO, (b) the reference reader's ISO
      if (!scrub) check(sha256(extracted) === sha256(original), () => `rom-weaver extract sha256 ${sha256(extracted).slice(0, 16)} != original ISO ${sha256(original).slice(0, 16)}`);
      check(sha256(extracted) === sha256(viaDolphin), () => `rom-weaver extract sha256 ${sha256(extracted).slice(0, 16)} != dolphin-tool convert -f iso ${sha256(viaDolphin).slice(0, 16)}`);
      ctx.same(extracted, viaDolphin, "extract vs dolphin-tool ISO");
      // (c) patch apply with the container as source == apply to the raw ISO. A scrubbed container no longer
      // matches the BPS source checksum, so only the checksum-free IPS patch is used there.
      for (const patchKind of scrub ? ["ips"] : ["ips", "bps"]) {
        const patch = ctx.fx(`reference/gc/disc.${patchKind}`);
        const raw = ctx.tmp(`raw-${patchKind}.iso`);
        const viaContainer = ctx.tmp(`via-${patchKind}.iso`);
        ctx.ok(ctx.apply(scrub ? viaDolphin : original, patch, raw), `${patchKind} apply to raw ISO`);
        ctx.ok(ctx.apply(container, patch, viaContainer), `${patchKind} apply to ${kind}`);
        ctx.same(viaContainer, raw, `${patchKind}: apply via ${kind} vs raw ISO`);
        if (!scrub) ctx.same(viaContainer, ctx.fx(TARGET), `${patchKind}: apply via ${kind} vs expected target`);
      }
    });
  };
  for (const [id, flags] of WIA) discCase("wia", id, { scrub: flags.includes("-s") });
  for (const [id] of GCZ) discCase("gcz", id, { scrub: id.endsWith("scrub") });
  for (const [id] of GCZ_SMALL) discCase("gcz", id);

  add("reference.wia.extract-determinism-and-threads", ["reference", "wia", "determinism"], (ctx) => {
    needTool("dolphin-tool");
    const container = ctx.fx(fixtureName("wia", "lzma2-l5-bs4m"));
    const a = extractOne(ctx, container, "a");
    const b = ctx.run(["extract", "--input", container, "--output", ctx.tmp("b"), "-j", "1"]);
    ctx.ok(b, "extract -j1");
    ctx.same(filesUnder(ctx.tmp("b"))[0], a, "-j1 vs default threads");
  });

  // ---------------------------------------------------------------- damaged containers
  const judgeExtract = (ctx, run, what) => {
    check(!run.timedOut, `${what}: timed out`);
    check(!run.panic, () => `${what}: crash/panic :: ${ctx.describe(run)}`);
    check([0, 1, 2].includes(run.code), () => `${what}: unexpected exit ${ctx.describe(run)}`);
  };
  const victims = [
    ["wia", "lzma2-l5-bs2m", 0xe0],
    ["wia", "none-bs2m", 0xe0],
    ["wia", "bzip2-l5-bs4m", 0xe0],
    ["gcz", "bs32k", 0x20],
    ["gcz", "bs256k", 0x20],
  ];
  for (const [kind, id, headerEnd] of victims) {
    const fixture = fixtureName(kind, id);
    const attempt = (ctx, bytes, label) => {
      const input = ctx.write(`damaged/${label}.${kind}`, bytes);
      const dir = ctx.tmp(`out-${label}`);
      return { run: ctx.run(["extract", "--input", input, "--output", dir]), dir, input, label };
    };
    const noLeftover = (outcome) => {
      if (outcome.run.code !== 0) check(filesUnder(outcome.dir).length === 0, () => `${outcome.label}: failed extract left ${filesUnder(outcome.dir).length} output file(s)`);
    };
    add(`reference.${kind}.damaged.${id}.truncate`, ["reference", kind, "negative", "fuzz"], (ctx) => {
      const bytes = fs.readFileSync(ctx.fx(fixture));
      const original = fs.readFileSync(ctx.fx(DISC));
      const cuts = new Set([0, 1, 3, 4, 7, 8, 16, 31, 32, 0x47, 0x48, 0x60, headerEnd - 1, headerEnd, headerEnd + 1, bytes.length - 1, bytes.length - 2]);
      for (let index = 1; index < 36; index++) cuts.add(Math.floor((bytes.length * index) / 36));
      for (const cut of [...cuts].filter((value) => value >= 0 && value < bytes.length).sort((a, b) => a - b)) {
        const outcome = attempt(ctx, bytes.subarray(0, cut), `cut-${cut}`);
        judgeExtract(ctx, outcome.run, `${kind} cut at ${cut}/${bytes.length}`);
        noLeftover(outcome);
        if (outcome.run.code === 0) {
          const files = filesUnder(outcome.dir);
          check(files.length === 1 && fs.readFileSync(files[0]).equals(original), `${kind} truncated to ${cut}/${bytes.length} bytes extracted with exit 0 but not to the original ISO`);
        }
        if (cut % 3 === 0) {
          const applied = ctx.apply(outcome.input, ctx.fx("reference/gc/disc.ips"), ctx.tmp(`apply-${cut}.iso`));
          judgeExtract(ctx, applied, `${kind} apply, cut at ${cut}`);
          if (applied.code !== 0) check(!ctx.exists(ctx.tmp(`apply-${cut}.iso`)), `${kind} cut ${cut}: failed apply left an output`);
        }
      }
    });
    add(`reference.${kind}.damaged.${id}.bitflip`, ["reference", kind, "negative", "fuzz"], (ctx) => {
      const bytes = fs.readFileSync(ctx.fx(fixture));
      const original = fs.readFileSync(ctx.fx(DISC));
      const positions = new Set();
      for (let at = 0; at < Math.min(headerEnd + 0x40, bytes.length); at += 5) positions.add(at);
      for (let index = 0; index < 40; index++) positions.add(Math.floor((bytes.length * index) / 40));
      positions.add(bytes.length - 1);
      const headerWrong = [];
      const bodyWrong = [];
      for (const at of [...positions].filter((value) => value < bytes.length).sort((a, b) => a - b)) {
        const mutated = Buffer.from(bytes);
        mutated[at] ^= 0xff;
        const outcome = attempt(ctx, mutated, `flip-${at}`);
        judgeExtract(ctx, outcome.run, `${kind} flip byte ${at}/${bytes.length}`);
        noLeftover(outcome);
        if (outcome.run.code === 0) {
          const files = filesUnder(outcome.dir);
          if (files.length !== 1 || !fs.readFileSync(files[0]).equals(original)) (at < headerEnd ? headerWrong : bodyWrong).push(at);
        }
        fs.rmSync(outcome.dir, { recursive: true, force: true });
      }
      if (bodyWrong.length) ctx.note(`${kind} ${id}: flipping payload bytes ${bodyWrong.slice(0, 6).join(",")}${bodyWrong.length > 6 ? ",..." : ""} (${bodyWrong.length} total) extracted with exit 0 to a different ISO (corruption undetected by rom-weaver)`);
      check(headerWrong.length === 0, () => `${kind} header flips at ${headerWrong.slice(0, 8).join(",")} extracted with exit 0 to a different ISO`);
    });
  }
  for (const kind of ["wia", "gcz"]) {
    add(`reference.${kind}.damaged.garbage-and-empty`, ["reference", kind, "negative"], (ctx) => {
      const magic = kind === "wia" ? "WIA\u0001" : "GCZ";
      const cases = [
        ["empty", Buffer.alloc(0)],
        ["magic-only", Buffer.from(magic, "latin1")],
        ["zeros", Buffer.alloc(4096)],
        ["random", Buffer.from(prngBytes(8192, 0x77))],
        ["magic-then-random", Buffer.concat([Buffer.from(magic, "latin1"), Buffer.from(prngBytes(8192, 0x78))])],
      ];
      for (const [label, bytes] of cases) {
        const input = ctx.write(`g/${label}.${kind}`, bytes);
        const dir = ctx.tmp(`g-out-${label}`);
        const run = ctx.run(["extract", "--input", input, "--output", dir]);
        ctx.failed(run, { what: `${kind} ${label} extract` });
        check(filesUnder(dir).length === 0, `${kind} ${label}: failed extract left output`);
        const applied = ctx.apply(input, ctx.fx("reference/gc/disc.ips"), ctx.tmp(`g-${label}.iso`));
        ctx.failed(applied, { what: `${kind} ${label} apply` });
        check(!ctx.exists(ctx.tmp(`g-${label}.iso`)), `${kind} ${label}: failed apply left output`);
      }
    });
  }
  add("reference.gcz.same-disc-different-block-sizes-extract-identically", ["reference", "gcz"], (ctx) => {
    needTool("dolphin-tool");
    const outputs = ["bs32k", "bs256k", "bs2048k"].map((id) => extractOne(ctx, ctx.fx(fixtureName("gcz", id)), `x-${id}`));
    for (const out of outputs.slice(1)) check(sameBytes(out, outputs[0]), "GCZ block size changed the extracted ISO");
  });
};
