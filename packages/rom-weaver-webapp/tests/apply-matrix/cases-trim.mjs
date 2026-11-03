// Trim route (trim-rom): every trim-capable input type x every output format the UI offers, archive
// inputs, unsupported/invalid inputs, round trip through the native revert, mobile viewport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cliPath } from "../fixtures/apply-matrix/generate.mjs";
import { prng, sha256, zip as zipEncode } from "../fixtures/apply-matrix/encoders.mjs";
import { buildGba, build3ds, buildNds, crc32Hex, EXH_CACHE, FIXTURE_ROOT, trimFixtures } from "./lib/gen.mjs";
import {
  codecOptions,
  openOptions,
  optionsOf,
  runTrim,
  setCodec,
  setLevel,
  setSelect,
  TRIM_BUTTON,
  mainText,
  visibleErrors,
  waitEnabled,
} from "./lib/flows.mjs";
import { assert, Skip } from "./lib/scenario.mjs";
import { chdUserData, extractWithHost, have, testWithHost, withTempDir } from "./lib/tools.mjs";
import { DESKTOP, MOBILE, newSession, stage } from "./lib/ui.mjs";

const TRIM_INPUT = "#trim-builder-input-file-unified";
const FIXTURES = FIXTURE_ROOT;
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

/** Native CLI trim of `bytes` (named `name`); returns the trimmed bytes or { error }. */
function nativeTrim(bytes, name, extra = []) {
  const bin = cliPath();
  if (!bin) return null;
  return withTempDir((dir) => {
    const input = path.join(dir, name);
    const output = path.join(dir, `out-${name}`);
    fs.writeFileSync(input, bytes);
    const result = spawnSync(
      bin,
      ["trim", "--input", input, "--output", output, "--force", "--no-progress", ...extra],
      {
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    if (result.status !== 0 || !fs.existsSync(output))
      return { error: `${result.stderr}${result.stdout}`.trim().split("\n").pop() };
    return { bytes: fs.readFileSync(output) };
  });
}

/** Stage `file` on the Trim route and wait until the run button settles. */
async function openTrim(h, files, { device = null, settle = 60_000 } = {}) {
  const session = await newSession(h.browser, h.baseUrl, { device, ready: TRIM_INPUT, route: "trim-rom" });
  const { page } = session;
  await stage(page, Array.isArray(files) ? files : [files], TRIM_INPUT);
  let enabled = true;
  try {
    await waitEnabled(page, TRIM_BUTTON, settle);
  } catch {
    enabled = false;
  }
  await page.waitForTimeout(1200);
  // The button can flicker enabled before the input is validated: re-read it after the settle delay.
  if (enabled) enabled = await page.evaluate((sel) => !document.querySelector(sel)?.disabled, TRIM_BUTTON);
  return { enabled, page, session };
}

const settleReport = (session, label) => {
  if (session.pageErrors.length) throw new Error(`${label}: page error ${session.pageErrors[0]}`);
};

/** Decode what the browser wrote back into the payload bytes we expect (null when not decodable here). */
function decodeOutput(format, out, expectedKind) {
  if (format === "zip" || format === "7z") {
    const extracted = extractWithHost(out.bytes, out.name);
    if (extracted.error) return { error: `host ${format} extract failed: ${extracted.error}` };
    if (extracted.files.length !== 1)
      return {
        error: `${format} holds ${extracted.files.length} entries: ${extracted.files.map((f) => f.name).join(", ")}`,
      };
    return { bytes: extracted.files[0].bytes, entryName: extracted.files[0].name };
  }
  if (format === "chd") {
    const result = chdUserData(out.bytes);
    if (!result) return null;
    return result.ok ? { bytes: result.bytes } : { error: `chdman rejected the chd: ${result.error}` };
  }
  if (format === "z3ds") {
    const bin = cliPath();
    if (!bin) return null;
    return withTempDir((dir) => {
      const input = path.join(dir, out.name);
      fs.writeFileSync(input, out.bytes);
      const outDir = path.join(dir, "x");
      const run = spawnSync(bin, ["extract", "--input", input, "--output", outDir, "--no-progress"], {
        encoding: "utf8",
      });
      if (run.status !== 0) return { error: `native extract of z3ds failed: ${run.stderr.trim().split("\n").pop()}` };
      const files = fs.readdirSync(outDir);
      return files.length === 1
        ? { bytes: fs.readFileSync(path.join(outDir, files[0])) }
        : { error: `z3ds extracted ${files.length} files` };
    });
  }
  void expectedKind;
  return { bytes: out.bytes };
}

function fixtureList() {
  const list = trimFixtures().map((fx) => ({
    id: fx.id,
    name: `rom.${fx.ext}`,
    ext: fx.ext,
    bytes: fx.bytes,
    kind: "rom",
    trimmedSize: fx.trimmedSize,
  }));
  const xiso = path.join(FIXTURES, "disc/xiso.xiso");
  list.push({
    id: "xiso",
    name: "rom.xiso",
    ext: "xiso",
    bytes: () => readIf(xiso),
    kind: "xiso",
    trimmedSize: undefined,
    missing: !fs.existsSync(xiso) && xiso,
  });
  return list;
}

export function trimCases() {
  const cases = [];
  const fixtures = fixtureList();

  // 1. Every fixture x every output format the UI offers (the offered set itself is asserted too).
  const formatsOf = (fx) => {
    if (fx.ext === "3ds") return ["3ds", "z3ds", "zip", "7z"];
    return [fx.ext, "zip", "7z"];
  };
  for (const fx of fixtures) {
    const expected = formatsOf(fx);
    cases.push({
      group: "trim",
      id: `trim/${fx.id}/offered-formats`,
      tags: ["trim", fx.id, "ui"],
      title: `trim ${fx.id}: output format list is exactly ${expected.join(",")}`,
      // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
      skip: fx.missing ? `fixture missing: ${fx.missing}` : undefined,
      async run(h) {
        const { page, session } = await openTrim(h, { buffer: fx.bytes(), name: fx.name });
        try {
          const offered = (await optionsOf(page, "#trim-builder-select-output-format")).map((option) => option.value);
          assert(
            offered.length === expected.length && expected.every((value) => offered.includes(value)),
            `offered ${offered.join(",")}, expected ${expected.join(",")}`,
          );
          settleReport(session, fx.id);
          return offered.join(",");
        } finally {
          await session.context.close();
        }
      },
    });
    for (const wanted of expected) {
      cases.push({
        group: "trim",
        id: `trim/${fx.id}/${wanted}`,
        tags: ["trim", fx.id, wanted],
        title: `trim ${fx.id} -> ${wanted}`,
        // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
        skip: fx.missing ? `fixture missing: ${fx.missing}` : undefined,
        async run(h) {
          const bytes = fx.bytes();
          const { page, session, enabled } = await openTrim(h, { buffer: bytes, name: fx.name });
          try {
            if (!enabled) throw new Error(`trim button never enabled; ${await mainText(page)}`);
            if (!(await setSelect(page, "#trim-builder-select-output-format", wanted)))
              throw new Error(`format ${wanted} not offered`);
            const out = await runTrim(page, h.caseDir);
            settleReport(session, fx.id);
            if (out.kind !== "download")
              throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""}) ${await mainText(page)}`);
            const decoded = decodeOutput(wanted, out);
            // quality-reason: chd and z3ds outputs are judged by chdman or the native CLI; without the verifier the bytes are unchecked, so the case skips instead of passing.
            if (decoded === null) throw new Skip(`no host verifier for the ${wanted} output`);
            const notes = [`${out.name} ${out.bytes.length}B`];
            if (decoded?.error) throw new Error(decoded.error);
            const payload = decoded?.bytes ?? null;
            assert(out.name.toLowerCase().endsWith(`.${wanted}`), `download ${out.name} lacks .${wanted}`);
            if (payload && (fx.kind === "rom" || fx.kind === "xiso")) {
              if (fx.trimmedSize != null) {
                assert(
                  payload.length === fx.trimmedSize,
                  `trimmed payload is ${payload.length} B, want ${fx.trimmedSize} B`,
                );
                assert(
                  Buffer.compare(payload, bytes.subarray(0, fx.trimmedSize)) === 0,
                  "trimmed payload is not a prefix of the source",
                );
              }
              const native = nativeTrim(bytes, fx.name);
              if (native?.error) notes.push(`native-trim-error(${native.error})`);
              else if (native) {
                assert(
                  sha256(payload) === sha256(native.bytes),
                  `webapp trim differs from native CLI trim: ${payload.length} B vs ${native.bytes.length} B`,
                );
                notes.push("== native");
              }
            }
            return notes.join(" ");
          } finally {
            await session.context.close();
          }
        },
      });
    }
  }

  // 2. Codec x level on the container outputs (a ROM that trims well).
  const rom = () => buildNds({ ntr: 0x3000, size: 0x8000 });
  for (const [format, codecs] of [
    ["zip", ["deflate", "store", "zstd"]],
    ["7z", ["lzma2"]],
  ]) {
    for (const codec of codecs) {
      for (const level of codec === "store"
        ? ["default"]
        : ["min", "very-low", "low", "medium", "high", "very-high", "max"]) {
        cases.push({
          group: "trim",
          id: `trim/nds/${String(format)}/${String(codec)}/${String(level)}`,
          tags: ["trim", "codec", format, codec, level],
          title: `trim nds -> ${String(format)} codec=${String(codec)} level=${String(level)}`,
          async run(h) {
            const bytes = rom();
            const { page, session } = await openTrim(h, { buffer: bytes, name: "game.nds" });
            try {
              await setSelect(page, "#trim-builder-select-output-format", format);
              await openOptions(page);
              // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
              if (!(await setCodec(page, codec)))
                throw new Skip(`codec ${codec} not selectable: ${(await codecOptions(page)).join(",")}`);
              // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
              if (level !== "default" && !(await setLevel(page, level)))
                throw new Skip("no compression level control for this codec");
              const out = await runTrim(page, h.caseDir);
              settleReport(session, "trim");
              if (out.kind !== "download") throw new Error(`no download (${out.kind}) ${out.text || ""}`);
              const extracted = extractWithHost(out.bytes, out.name);
              if (extracted.error) throw new Error(extracted.error);
              assert(
                extracted.files.length === 1 &&
                  Buffer.compare(extracted.files[0].bytes, bytes.subarray(0, 0x3000)) === 0,
                "archive content is not the trimmed ROM",
              );
              const bad = testWithHost(out.bytes, out.name);
              if (bad && bad !== "no 7z") throw new Error(`7z t: ${bad}`);
              return `${out.name} ${out.bytes.length}B`;
            } finally {
              await session.context.close();
            }
          },
        });
      }
    }
  }

  // 3. Round trip: web trim -> native revert restores the (power-of-two, 0xFF padded) original.
  for (const kind of ["nds", "gba", "3ds"]) {
    cases.push({
      group: "trim",
      id: `trim/roundtrip/${kind}`,
      tags: ["trim", "roundtrip", kind],
      title: `trim ${kind} in the browser, revert with the native CLI`,
      async run(h) {
        const bin = cliPath();
        // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
        if (!bin) throw new Skip("native CLI not built");
        let original;
        if (kind === "nds") {
          original = buildNds({ ntr: 0x3000, size: 0x4000 }); // revert pads to the next power of two
          original.fill(0xff, 0x3000);
        } else if (kind === "gba") original = buildGba({ pad: 0xff, total: 0x8000 });
        else original = build3ds({ pad: 0xff, total: 0x10000 });
        const name = `rt.${kind}`;
        const { page, session } = await openTrim(h, { buffer: original, name });
        try {
          await setSelect(page, "#trim-builder-select-output-format", kind);
          const out = await runTrim(page, h.caseDir);
          settleReport(session, "trim");
          if (out.kind !== "download") throw new Error(`no download (${out.kind})`);
          assert(out.name.toLowerCase().endsWith(`.${kind}`), `download ${out.name} lacks .${kind}`);
          assert(out.bytes.length < original.length, `not smaller: ${out.bytes.length} >= ${original.length}`);
          const restored = withTempDir((dir) => {
            const trimmed = path.join(dir, name);
            const target = path.join(dir, `r-${name}`);
            fs.writeFileSync(trimmed, out.bytes);
            const r = spawnSync(
              bin,
              ["trim", "--revert", "--input", trimmed, "--output", target, "--force", "--no-progress"],
              { encoding: "utf8" },
            );
            return r.status === 0 && fs.existsSync(target)
              ? fs.readFileSync(target)
              : { error: `${r.stderr}${r.stdout}`.trim().split("\n").pop() };
          });
          if (restored.error) throw new Error(`native revert failed: ${restored.error}`);
          assert(
            sha256(restored) === sha256(original),
            `revert gave ${restored.length} B, original ${original.length} B (sha differs)`,
          );
          return `trimmed ${out.bytes.length} B -> reverted ${restored.length} B == original`;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 4. Archive inputs: a zip holding a ROM is unwrapped and trimmed.
  for (const wrapper of ["zip", "7z-host"]) {
    cases.push({
      group: "trim",
      id: `trim/archive-input/${wrapper}`,
      tags: ["trim", "archive", wrapper],
      title: `trim a ROM inside a ${wrapper}`,
      async run(h) {
        const bytes = buildNds({ ntr: 0x3000, size: 0x5000 });
        let archive;
        if (wrapper === "zip") archive = Buffer.from(zipEncode([{ name: "inside/game.nds", data: bytes }]));
        else {
          // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
          if (!have("7z")) throw new Skip("no host 7z");
          archive = withTempDir((dir) => {
            fs.writeFileSync(path.join(dir, "game.nds"), bytes);
            spawnSync("7z", ["a", "-bd", path.join(dir, "a.7z"), path.join(dir, "game.nds")], { encoding: "utf8" });
            return fs.readFileSync(path.join(dir, "a.7z"));
          });
        }
        const { page, session, enabled } = await openTrim(h, {
          buffer: archive,
          name: wrapper === "zip" ? "pack.zip" : "pack.7z",
        });
        try {
          if (!enabled)
            throw new Error(
              `trim never enabled for archive input: ${await mainText(page)} ${await visibleErrors(page)}`,
            );
          const out = await runTrim(page, h.caseDir);
          settleReport(session, "trim");
          if (out.kind !== "download") throw new Error(`no download (${out.kind}) ${out.text || ""}`);
          const payload = out.name.toLowerCase().endsWith(".nds")
            ? out.bytes
            : extractWithHost(out.bytes, out.name).files?.[0]?.bytes;
          assert(payload && payload.length === 0x3000, `trimmed size ${payload?.length}, want 12288`);
          return out.name;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 5. Unsupported / invalid inputs: the UI must say so and not produce a corrupt file.
  const bad = [
    {
      id: "plain-bin",
      name: "x.bin",
      bytes: () => Buffer.alloc(4096, 7),
      want: /not support trimming|unsupported|cannot|not a/i,
    },
    {
      id: "zero-byte-nds",
      name: "empty.nds",
      bytes: () => Buffer.alloc(0),
      want: /empty|invalid|cannot|unsupported|could not|error|0 B/i,
    },
    {
      id: "one-byte-nds",
      name: "one.nds",
      bytes: () => Buffer.from([1]),
      want: /header|invalid|unsupported|cannot|could not|error|small/i,
    },
    {
      id: "nds-bad-header-crc",
      name: "badcrc.nds",
      bytes: () => {
        const rom = buildNds();
        rom[0x15e] ^= 0xff;
        return rom;
      },
      want: /crc|header|invalid|unsupported|could not|error/i,
    },
    {
      id: "nds-truncated-header",
      name: "short.nds",
      bytes: () => buildNds().subarray(0, 0x100),
      want: /header|invalid|unsupported|could not|small|error/i,
    },
    {
      id: "gba-empty",
      name: "empty.gba",
      bytes: () => Buffer.alloc(0),
      want: /empty|invalid|cannot|unsupported|could not|error/i,
    },
    {
      id: "3ds-no-ncsd",
      name: "bad.3ds",
      bytes: () => Buffer.alloc(0x4000, 0xff),
      want: /ncsd|ncch|invalid|unsupported|could not|error/i,
    },
    {
      id: "3ds-partition-overflow",
      name: "over.3ds",
      bytes: () => {
        const rom = build3ds();
        rom.writeUInt32LE(0x7fffff, 0x124);
        return rom;
      },
      want: /ncsd|partition|invalid|exceeds|could not|error/i,
    },
    {
      id: "garbage-xiso",
      name: "bad.xiso",
      bytes: () => Buffer.alloc(0x20000, 0x5a),
      want: /xdvdfs|xiso|invalid|unsupported|not a|could not|error/i,
    },
    // GameCube/Wii discs are not trimmed (Compress writes them as RVZ), so staging must refuse them.
    {
      id: "gamecube-iso",
      name: "game.iso",
      bytes: () => readIf(path.join(FIXTURES, "reference/gc/disc.iso")),
      want: /not support trimming.*Compress/is,
      missing: path.join(FIXTURES, "reference/gc/disc.iso"),
    },
    {
      id: "gamecube-gcm",
      name: "game.gcm",
      bytes: () => readIf(path.join(FIXTURES, "reference/gc/disc.iso")),
      want: /not support trimming.*Compress/is,
      missing: path.join(FIXTURES, "reference/gc/disc.iso"),
    },
    {
      id: "wbfs-disc",
      name: "game.wbfs",
      bytes: () => readIf(path.join(FIXTURES, "disc/wbfs.wbfs")),
      want: /not support trimming.*Compress/is,
      missing: path.join(FIXTURES, "disc/wbfs.wbfs"),
    },
    {
      id: "rvz-disc",
      name: "game.rvz",
      bytes: () => readIf(path.join(FIXTURES, "disc/made.rvz")),
      want: /not support trimming.*Compress/is,
      missing: path.join(FIXTURES, "disc/made.rvz"),
    },
    {
      id: "mac-text-file",
      name: "readme.txt",
      bytes: () => Buffer.from("hello"),
      want: /not support|unsupported|cannot|not a|error/i,
    },
  ];
  for (const fx of bad) {
    cases.push({
      group: "trim",
      id: `trim/invalid/${fx.id}`,
      tags: ["trim", "invalid", fx.id],
      title: `trim ${fx.id}: refused with a visible message, no download`,
      // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
      skip: fx.missing && !fs.existsSync(fx.missing) ? `fixture missing: ${fx.missing}` : undefined,
      async run(h) {
        const { page, session, enabled } = await openTrim(h, { buffer: fx.bytes(), name: fx.name }, { settle: 25_000 });
        try {
          const staged = `${await mainText(page)} ${(await visibleErrors(page)).join(" | ")}`;
          let outcome = { kind: "blocked" };
          if (enabled) outcome = await runTrim(page, h.caseDir, { timeout: 40_000 });
          settleReport(session, fx.id);
          if (outcome.kind === "download")
            throw new Error(`produced a download (${outcome.name}, ${outcome.bytes.length} B) for an invalid input`);
          if (outcome.kind === "timeout") throw new Error(`UI hung: ${await mainText(page)}`);
          const text = `${staged} ${outcome.text || ""} ${(await visibleErrors(page)).join(" | ")}`;
          assert(fx.want.test(text), `no explanatory message (wanted ${fx.want}); visible: ${text.slice(0, 300)}`);
          return `${outcome.kind}${enabled ? " (button was enabled)" : " (button disabled)"}`;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 6. Repeated runs in one session, with re-selecting a different format in between.
  cases.push({
    group: "trim",
    id: "trim/repeat/three-runs-one-session",
    tags: ["trim", "repeat"],
    title: "trim the same ROM three times in one session (own, zip, own)",
    async run(h) {
      const bytes = buildNds({ ntr: 0x3000, size: 0x5000 });
      const { page, session } = await openTrim(h, { buffer: bytes, name: "again.nds" });
      try {
        const seen = [];
        for (const format of ["nds", "zip", "nds"]) {
          await setSelect(page, "#trim-builder-select-output-format", format);
          const out = await runTrim(page, h.caseDir);
          settleReport(session, "repeat");
          if (out.kind !== "download")
            throw new Error(`run ${seen.length + 1} (${format}): no download (${out.kind}) ${out.text || ""}`);
          const payload = format === "zip" ? extractWithHost(out.bytes, out.name).files?.[0]?.bytes : out.bytes;
          assert(payload && payload.length === 0x3000, `run ${seen.length + 1} produced ${payload?.length} B`);
          seen.push(out.name);
          await page.waitForTimeout(600);
        }
        return seen.join(" | ");
      } finally {
        await session.context.close();
      }
    },
  });

  // 7. Mobile viewport.
  cases.push({
    group: "trim",
    id: "trim/mobile/nds",
    tags: ["trim", "mobile"],
    title: "trim an NDS on a 390x780 touch viewport",
    async run(h) {
      const bytes = buildNds({ ntr: 0x3000, size: 0x5000 });
      const { page, session, enabled } = await openTrim(h, { buffer: bytes, name: "m.nds" }, { device: MOBILE });
      try {
        assert(enabled, `trim never enabled on mobile: ${await mainText(page)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 2, `horizontal overflow of ${overflow}px on a 390 px viewport`);
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile.png") });
        const out = await runTrim(page, h.caseDir);
        settleReport(session, "mobile");
        if (out.kind !== "download") throw new Error(`no download (${out.kind}) ${out.text || ""}`);
        assert(out.bytes.length === 0x3000, `trimmed size ${out.bytes.length}`);
        return out.name;
      } finally {
        await session.context.close();
      }
    },
  });

  // 7b. Large: a full-size 32 MiB GBA cart image (16 MiB of data, 16 MiB of 0xFF padding).
  for (const format of ["gba", "zip", "7z"]) {
    cases.push({
      group: "trim",
      id: `trim/large/gba-32mib/${format}`,
      tags: ["trim", "large", format],
      title: `trim a 32 MiB GBA image -> ${format}`,
      async run(h) {
        const used = 16 << 20;
        const file = path.join(EXH_CACHE, "trim-gba-32mib.gba");
        if (!fs.existsSync(file)) {
          const rom = Buffer.alloc(32 << 20, 0xff);
          Buffer.from(prng(used, 0x6ba)).copy(rom);
          rom[used - 1] = 0x12;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, rom);
        }
        const { page, session, enabled } = await openTrim(h, file, { settle: 120_000 });
        try {
          assert(enabled, `trim never enabled: ${await mainText(page)}`);
          await setSelect(page, "#trim-builder-select-output-format", format);
          const out = await runTrim(page, h.caseDir, { timeout: 300_000 });
          settleReport(session, "large");
          if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
          const payload = format === "gba" ? out.bytes : extractWithHost(out.bytes, out.name).files?.[0]?.bytes;
          assert(payload && payload.length === used, `trimmed size ${payload?.length}, want ${used}`);
          assert(
            Buffer.compare(payload.subarray(0, 65536), Buffer.from(prng(65536, 0x6ba))) === 0,
            "payload prefix differs",
          );
          return `${out.name} ${out.bytes.length}B`;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 8. Output-name handling.
  for (const [label, name] of [
    ["unicode", "ゲーム é 🎮 (trimmed)"],
    ["spaces", "  two  spaces  "],
    ["dots", "a.b.c"],
    ["reserved", 'we<ir>d:"n|a?*me'],
    ["empty", ""],
  ]) {
    cases.push({
      group: "trim",
      id: `trim/naming/${label}`,
      tags: ["trim", "naming", label],
      title: `trim output name ${JSON.stringify(name)}`,
      async run(h) {
        const bytes = buildNds({ ntr: 0x3000, size: 0x5000 });
        const { page, session } = await openTrim(h, { buffer: bytes, name: "ゲーム é.nds" });
        try {
          const field = page.locator("#trim-builder-output-file");
          await field.fill(name);
          await field.blur();
          await page.waitForTimeout(500);
          const out = await runTrim(page, h.caseDir);
          settleReport(session, "naming");
          if (out.kind !== "download") throw new Error(`no download (${out.kind}) ${out.text || ""}`);
          assert(
            out.name.length > 0 && !/[/\\<>:"|?*]/.test(out.name),
            `unsafe download name ${JSON.stringify(out.name)}`,
          );
          assert(/\.nds$/i.test(out.name) && !/\.nds\.nds$/i.test(out.name), `bad extension on ${out.name}`);
          assert(out.bytes.length === 0x3000, `size ${out.bytes.length}`);
          return out.name;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  void DESKTOP;
  void os;
  void crc32Hex;
  return cases;
}
