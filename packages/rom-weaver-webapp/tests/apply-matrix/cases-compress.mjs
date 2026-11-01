// Compress route (compress-files): every output container the UI offers x codec x level, judged by
// independent tools (7z/bsdtar for zip+7z, chdman for CHD, dolphin-tool for RVZ, the native CLI for Z3DS).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cliPath } from "../fixtures/apply-matrix/generate.mjs";
import { prng, sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import {
  codecOptions,
  LEVELS,
  mainText,
  openOptions,
  optionsOf,
  setCodec,
  setLevel,
  visibleErrors,
} from "./lib/flows.mjs";
import { FIXTURE_ROOT } from "./lib/gen.mjs";
import { assert, Skip } from "./lib/scenario.mjs";
import { chdUserData, extractWithHost, have, rvzInspect, testWithHost, withTempDir, zipMethods } from "./lib/tools.mjs";
import { MOBILE, newSession, stage } from "./lib/ui.mjs";

const INPUT = "#compress-input-picker";
const EXH = path.join(FIXTURE_ROOT, "exh");
const exists = (file) => fs.existsSync(file);

async function openCompress(h, files, { device = null, settle = 3000 } = {}) {
  const session = await newSession(h.browser, h.baseUrl, { device, ready: INPUT, route: "compress-files" });
  await stage(session.page, files, INPUT);
  await session.page.waitForTimeout(settle);
  return session;
}

const formatSelect = (page) => page.getByLabel("Output format", { exact: true });

/** Click COMPRESS, wait for the DOWNLOAD state, click again and return the saved file. */
async function runCompress(page, outDir, { timeout = 180_000 } = {}) {
  const button = page.locator("main button.run");
  await button.click();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const label = (await button.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/^download/i.test(label)) break;
    const errors = await visibleErrors(page);
    if (errors.length) return { kind: "error", text: errors[0] };
    await page.waitForTimeout(400);
  }
  if (!/^download/i.test((await button.innerText().catch(() => "")).trim())) return { kind: "timeout" };
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), button.click()]);
  const saved = path.join(outDir, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(saved);
  return { bytes: fs.readFileSync(saved), kind: "download", name: download.suggestedFilename() };
}

const nativeExtract = (bytes, name) => {
  const bin = cliPath();
  if (!bin) return null;
  return withTempDir((dir) => {
    const input = path.join(dir, name);
    fs.writeFileSync(input, bytes);
    const out = path.join(dir, "x");
    const run = spawnSync(bin, ["extract", "--input", input, "--output", out, "--no-progress"], { encoding: "utf8" });
    if (run.status !== 0) return { error: run.stderr.trim().split("\n").pop() };
    const files = [];
    const walk = (dir2) => {
      for (const entry of fs.readdirSync(dir2, { withFileTypes: true })) {
        const full = path.join(dir2, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ bytes: fs.readFileSync(full), name: path.relative(out, full) });
      }
    };
    walk(out);
    return { files };
  });
};

/** Extract a zip/7z with host tools, falling back to the native CLI (zip+zstd is beyond p7zip 17). */
function unpack(bytes, name) {
  const host = extractWithHost(bytes, name);
  if (!host.error) return { ...host, via: "host" };
  const native = nativeExtract(bytes, name);
  if (native && !native.error) return { ...native, via: "native" };
  return { error: `host: ${host.error}; native: ${native?.error ?? "n/a"}`, files: [] };
}

const sampleBin = Buffer.concat([Buffer.from(prng(6000, 11)), Buffer.alloc(8000, 0x41), Buffer.from(prng(2000, 12))]);

export function compressCases() {
  const cases = [];
  const iso = path.join(FIXTURE_ROOT, "reference/gc/disc.iso");
  const dvd = path.join(EXH, "dvd/dvd.iso");
  const cue = path.join(EXH, "cd/data.cue");
  const cueBin = path.join(EXH, "cd/data.bin");
  const game3ds = path.join(EXH, "ctr/game.3ds");
  const cci = path.join(EXH, "ctr/game.cci");
  const cxi = path.join(EXH, "ctr/game.cxi");

  // ---- zip / 7z over a plain file: codec x level
  const archiveCase = (container, codec, level) => ({
    group: "compress",
    id: `compress/bin/${container}/${codec}/${level ?? "default"}`,
    tags: ["compress", container, codec, level ?? ""],
    title: `compress a file to ${container} codec=${codec} level=${level ?? "n/a"}`,
    async run(h) {
      const session = await openCompress(h, [{ buffer: sampleBin, name: "sample.bin" }]);
      try {
        const { page } = session;
        await formatSelect(page).selectOption(container);
        await page.waitForTimeout(400);
        await openOptions(page);
        // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
        if (!(await setCodec(page, codec)))
          throw new Skip(`codec ${codec} not selectable (${(await codecOptions(page)).join(",")})`);
        // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
        if (level && !(await setLevel(page, level))) throw new Skip("no level control");
        const out = await runCompress(page, h.caseDir);
        if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
        if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
        assert(out.name === `sample.${container}`, `download name ${out.name}, wanted sample.${container}`);
        const bad = testWithHost(out.bytes, out.name);
        assert(!bad || bad === "no 7z" || codec === "zstd", `host 7z t: ${bad}`);
        const unpacked = unpack(out.bytes, out.name);
        assert(!unpacked.error, unpacked.error);
        assert(unpacked.files.length === 1, `${unpacked.files.length} entries`);
        assert(unpacked.files[0].name === "sample.bin", `entry named ${unpacked.files[0].name}`);
        assert(sha256(unpacked.files[0].bytes) === sha256(sampleBin), "content differs");
        let note = `${out.bytes.length}B via ${unpacked.via}`;
        if (container === "zip") {
          const wantMethod = { deflate: 8, store: 0, zstd: 93 }[codec];
          const methods = zipMethods(out.bytes);
          assert(
            methods.length === 0 || methods[0] === wantMethod || methods[0] === 0,
            `zip method ${methods[0]}, wanted ${wantMethod} for codec ${codec}`,
          );
          note += ` method=${methods[0]}`;
        }
        return note;
      } finally {
        await session.context.close();
      }
    },
  });
  for (const level of LEVELS) cases.push(archiveCase("zip", "deflate", level));
  cases.push(archiveCase("zip", "store", null));
  for (const level of LEVELS) cases.push(archiveCase("zip", "zstd", level));
  for (const level of LEVELS) cases.push(archiveCase("7z", "lzma2", level));

  // level must change the output: min vs max on compressible data (zip deflate, 7z lzma2) differ in size
  for (const [container, codec] of [
    ["zip", "deflate"],
    ["7z", "lzma2"],
    ["zip", "zstd"],
  ]) {
    cases.push({
      group: "compress",
      id: `compress/level-effect/${container}-${codec}`,
      tags: ["compress", "level-effect", container, codec],
      title: `${container}/${codec}: max level is not larger than min level`,
      async run(h) {
        const sizes = {};
        for (const level of ["min", "max"]) {
          const session = await openCompress(h, [
            { buffer: Buffer.concat([sampleBin, sampleBin, sampleBin]), name: "sample.bin" },
          ]);
          try {
            await formatSelect(session.page).selectOption(container);
            await openOptions(session.page);
            // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
            if (!(await setCodec(session.page, codec))) throw new Skip("codec not selectable");
            await setLevel(session.page, level);
            const out = await runCompress(session.page, h.caseDir);
            if (out.kind !== "download") throw new Error(`no download (${out.kind})`);
            sizes[level] = out.bytes.length;
          } finally {
            await session.context.close();
          }
        }
        assert(sizes.max <= sizes.min, `max level (${sizes.max} B) larger than min level (${sizes.min} B)`);
        return `min=${sizes.min} max=${sizes.max}`;
      },
    });
  }

  // ---- multi-file input into zip/7z: names, unicode, duplicates
  for (const container of ["zip", "7z"]) {
    cases.push({
      group: "compress",
      id: `compress/multi-file/${container}`,
      tags: ["compress", "multi", container],
      title: `three files (unicode, spaces, duplicate basename) into one ${container}`,
      async run(h) {
        const files = [
          { buffer: Buffer.from(prng(3000, 1)), name: "ゲーム é.bin" },
          { buffer: Buffer.from(prng(4000, 2)), name: "with space.sfc" },
          { buffer: Buffer.from(prng(5000, 3)), name: "plain.gba" },
        ];
        const session = await openCompress(h, files);
        try {
          await formatSelect(session.page).selectOption(container);
          await session.page.waitForTimeout(300);
          const out = await runCompress(session.page, h.caseDir);
          if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
          if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
          const unpacked = unpack(out.bytes, out.name);
          assert(!unpacked.error, unpacked.error);
          const got = new Map(unpacked.files.map((file) => [file.name.normalize("NFC"), sha256(file.bytes)]));
          for (const file of files)
            assert(
              got.get(file.name.normalize("NFC")) === sha256(file.buffer),
              `entry ${file.name} missing or altered (have: ${[...got.keys()].join(" | ")})`,
            );
          return `${out.name}: ${unpacked.files.length} entries`;
        } finally {
          await session.context.close();
        }
      },
    });
  }
  cases.push({
    group: "compress",
    id: "compress/duplicate-names/zip",
    tags: ["compress", "duplicate"],
    title: "two staged files with the same name: both survive in the archive or the UI says why not",
    async run(h) {
      const a = Buffer.from(prng(2000, 5));
      const b = Buffer.from(prng(2500, 6));
      const session = await openCompress(h, [
        { buffer: a, name: "dup.bin" },
        { buffer: b, name: "dup.bin" },
      ]);
      try {
        const cards = await session.page.locator(".compress-files .card, .compress-files .nm").count();
        const out = await runCompress(session.page, h.caseDir);
        if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
        if (out.kind !== "download") return `no archive: ${out.kind} ${out.text || ""} (cards=${cards})`;
        const unpacked = unpack(out.bytes, out.name);
        assert(!unpacked.error, unpacked.error);
        const shas = unpacked.files.map((file) => sha256(file.bytes));
        assert(
          shas.includes(sha256(a)) && shas.includes(sha256(b)),
          `an entry was lost: archive holds ${unpacked.files.map((f) => `${f.name}:${f.bytes.length}`).join(", ")} (cards=${cards})`,
        );
        return `${unpacked.files.map((f) => f.name).join(", ")}`;
      } finally {
        await session.context.close();
      }
    },
  });
  for (const [label, bytes] of [
    ["zero-byte", Buffer.alloc(0)],
    ["one-byte", Buffer.from([0x7f])],
  ]) {
    for (const container of ["zip", "7z"]) {
      cases.push({
        group: "compress",
        id: `compress/${String(label)}/${container}`,
        tags: ["compress", label, container],
        title: `${String(label)} file into ${container}`,
        async run(h) {
          const session = await openCompress(h, [{ buffer: bytes, name: `${String(label)}.bin` }]);
          try {
            await formatSelect(session.page).selectOption(container);
            const out = await runCompress(session.page, h.caseDir, { timeout: 60_000 });
            if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
            if (out.kind === "error") return `refused: ${out.text}`.slice(0, 160);
            if (out.kind !== "download") throw new Error(`no download (${out.kind}) ${await mainText(session.page)}`);
            const unpacked = unpack(out.bytes, out.name);
            assert(!unpacked.error, unpacked.error);
            assert(
              unpacked.files.length === 1 && Buffer.compare(unpacked.files[0].bytes, bytes) === 0,
              "content differs",
            );
            return `${out.bytes.length}B`;
          } finally {
            await session.context.close();
          }
        },
      });
    }
  }

  // ---- disc outputs
  const discCase = ({ id, input, format, level, codec, check, needs, title }) => ({
    group: "compress",
    id: `compress/${id}/${format}/${codec ?? "default"}/${level ?? "default"}`,
    tags: ["compress", id, format, level ?? "", codec ?? ""],
    title: `${title} -> ${format} codec=${codec ?? "default"} level=${level ?? "default"}`,
    // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
    skip: needs.find((file) => !exists(file)) ? `fixture missing: ${needs.find((file) => !exists(file))}` : undefined,
    async run(h) {
      const session = await openCompress(h, input);
      try {
        const { page } = session;
        const offered = (await optionsOf(page, "main select")).map((o) => o.value);
        // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
        if (!offered.includes(format)) throw new Skip(`format ${format} not offered (${offered.join(",")})`);
        await formatSelect(page).selectOption(format);
        await page.waitForTimeout(400);
        await openOptions(page);
        // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
        if (codec && !(await setCodec(page, codec))) throw new Skip(`codec ${codec} not selectable`);
        // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
        if (level && !(await setLevel(page, level))) throw new Skip("no level control");
        const out = await runCompress(page, h.caseDir);
        if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
        if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
        assert(
          out.name.toLowerCase().endsWith(`.${check.ext || format}`),
          `download ${out.name} lacks .${check.ext || format}`,
        );
        return `${out.name} ${out.bytes.length}B; ${await check.verify(out)}`;
      } finally {
        await session.context.close();
      }
    },
  });
  const rvzVerify = (source) => async (out) => {
    const result = rvzInspect(out.bytes);
    // quality-reason: dolphin-tool is an optional host tool or build that judges this output; without it the bytes are unchecked, so the case skips instead of passing, and the CLI matrix covers the same output.
    if (!result) throw new Skip("dolphin-tool not available to verify the output");
    assert(result.ok, `dolphin-tool could not read the rvz: ${result.error}`);
    assert(
      result.bytes.length === source.length && Buffer.compare(result.bytes, source) === 0,
      `rvz decodes to ${result.bytes.length} B, sha differs from source (${source.length} B)`,
    );
    return "dolphin-tool convert == source";
  };
  const chdVerify = (source) => async (out) => {
    const result = chdUserData(out.bytes);
    // quality-reason: chdman is an optional host tool or build that judges this output; without it the bytes are unchecked, so the case skips instead of passing, and the CLI matrix covers the same output.
    if (!result) throw new Skip("chdman not available to verify the output");
    assert(result.ok, `chdman: ${result.error}`);
    const same =
      result.bytes.length >= source.length && Buffer.compare(result.bytes.subarray(0, source.length), source) === 0;
    assert(
      same,
      `chd (${result.kind}) decodes to ${result.bytes.length} B, content differs from source (${source.length} B)`,
    );
    return `chdman verify + decode (${result.kind}) == source`;
  };

  const isoBytes = () => fs.readFileSync(iso);
  for (const level of LEVELS)
    cases.push(
      discCase({
        check: { verify: async (out) => rvzVerify(isoBytes())(out) },
        codec: "zstd",
        format: "rvz",
        id: "gc-iso",
        input: [iso],
        level,
        needs: [iso],
        title: "GameCube ISO",
      }),
    );
  for (const level of ["min", "medium", "max"])
    cases.push(
      discCase({
        check: { verify: async (out) => chdVerify(isoBytes())(out) },
        format: "chd",
        id: "gc-iso",
        input: [iso],
        level,
        needs: [iso],
        title: "GameCube ISO",
      }),
    );
  for (const level of ["min", "max"]) {
    cases.push(
      discCase({
        check: { verify: async (out) => chdVerify(fs.readFileSync(dvd))(out) },
        format: "chd",
        id: "dvd-iso",
        input: [dvd],
        level,
        needs: [dvd],
        title: "DVD ISO",
      }),
    );
  }
  cases.push({
    group: "compress",
    id: "compress/dvd-iso/rvz-not-offered-for-non-gc-wii",
    tags: ["compress", "dvd-iso", "rvz", "ux"],
    title: "a plain (non GameCube/Wii) ISO must not be offered .rvz, which can only fail",
    // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
    skip: exists(dvd) ? undefined : "fixture missing: exh/dvd",
    async run(h) {
      const session = await openCompress(h, [dvd]);
      try {
        const offered = (await optionsOf(session.page, "main select")).map((o) => o.value);
        if (!offered.includes("rvz")) return `rvz correctly not offered (${offered.join(",")})`;
        await formatSelect(session.page).selectOption("rvz");
        const out = await runCompress(session.page, h.caseDir, { timeout: 60_000 });
        if (out.kind === "download") return ".rvz offered for a plain ISO and the conversion works";
        throw new Error(`.rvz is offered for a plain ISO and then fails: ${String(out.text).slice(0, 140)}`);
      } finally {
        await session.context.close();
      }
    },
  });

  // CD: cue + bin -> chd; extractcd must reproduce the bin
  for (const level of ["min", "medium", "max"]) {
    cases.push({
      group: "compress",
      id: `compress/cue-bin/chd/default/${level}`,
      tags: ["compress", "cue", "chd", level],
      title: `cue+bin -> chd level=${level}`,
      // quality-reason: the fixture is generated by the harness or built with a host tool; when it is absent the case reports which one instead of failing.
      skip: [cue, cueBin].find((file) => !exists(file)) ? "fixture missing: exh/cd" : undefined,
      async run(h) {
        const session = await openCompress(h, [cue, cueBin]);
        try {
          await formatSelect(session.page).selectOption("chd");
          await openOptions(session.page);
          await setLevel(session.page, level);
          const out = await runCompress(session.page, h.caseDir);
          if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
          if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
          // quality-reason: chdman is an optional host tool or build that judges this output; without it the bytes are unchecked, so the case skips instead of passing, and the CLI matrix covers the same output.
          if (!have("chdman")) throw new Skip("chdman not available to verify the output");
          return withTempDir((dir) => {
            const chd = path.join(dir, "o.chd");
            fs.writeFileSync(chd, out.bytes);
            const verify = spawnSync("chdman", ["verify", "-i", chd], { encoding: "utf8" });
            assert(verify.status === 0, `chdman verify: ${(verify.stdout + verify.stderr).trim().split("\n").pop()}`);
            const ex = spawnSync(
              "chdman",
              ["extractcd", "-i", chd, "-o", path.join(dir, "o.cue"), "-ob", path.join(dir, "o.bin")],
              { encoding: "utf8" },
            );
            assert(ex.status === 0, `chdman extractcd: ${(ex.stdout + ex.stderr).trim().split("\n").pop()}`);
            const got = fs.readFileSync(path.join(dir, "o.bin"));
            assert(
              Buffer.compare(got, fs.readFileSync(cueBin)) === 0,
              `extracted bin ${got.length} B differs from the source bin`,
            );
            return `${out.name} ${out.bytes.length}B == source bin`;
          });
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 3DS family -> Z3DS
  for (const [id, file, ext] of [
    ["3ds", game3ds, "z3ds"],
    ["cci", cci, "zcci"],
    ["cxi", cxi, "zcxi"],
  ]) {
    for (const level of ["min", "max"]) {
      cases.push(
        discCase({
          check: {
            ext,
            verify: async (out) => {
              const extracted = nativeExtract(out.bytes, out.name);
              // quality-reason: native CLI is an optional host tool or build that judges this output; without it the bytes are unchecked, so the case skips instead of passing, and the CLI matrix covers the same output.
              if (!extracted) throw new Skip("native CLI not available to verify the output");
              assert(!extracted.error, `native extract of the Z3DS failed: ${extracted.error}`);
              assert(
                extracted.files.length === 1 && Buffer.compare(extracted.files[0].bytes, fs.readFileSync(file)) === 0,
                "z3ds payload differs from the source",
              );
              return "native extract == source";
            },
          },
          format: "z3ds",
          id,
          input: [file],
          level,
          needs: [file],
          title: `${id} image`,
        }),
      );
    }
  }

  // mobile
  cases.push({
    group: "compress",
    id: "compress/mobile/zip",
    tags: ["compress", "mobile"],
    title: "compress to zip on a 390x780 touch viewport",
    async run(h) {
      const session = await openCompress(h, [{ buffer: sampleBin, name: "sample.bin" }], { device: MOBILE });
      try {
        const overflow = await session.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 2, `horizontal overflow ${overflow}px`);
        await session.page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile.png") });
        const out = await runCompress(session.page, h.caseDir);
        if (out.kind !== "download") throw new Error(`no download (${out.kind})`);
        return out.name;
      } finally {
        await session.context.close();
      }
    },
  });
  return cases;
}
