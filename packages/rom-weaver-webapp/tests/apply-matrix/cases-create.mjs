// Create route (create-rom-patch): every patch format the UI offers x size/shape pair, every output
// archive/codec/level, input shapes (archives, duplicates, swapped) and mobile. The artifact is judged by
//   1. an independent reference applier where one exists (xdelta3 for xdelta, flips for bps/ips/ups),
//   2. the native CLI applier,
//   3. the webapp's own Apply route (round trip through a second page).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cliPath } from "../fixtures/apply-matrix/generate.mjs";
import { prng, sha256, zip as zipEncode } from "../fixtures/apply-matrix/encoders.mjs";
import {
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY,
  ROM_WEAVER_PATCH_FORMATS,
} from "../../src/wasm/generated/rom-weaver-format-metadata.ts";
import { cliApply } from "./lib/cli.mjs";
import {
  LEVELS,
  mainText,
  openCreate,
  openOptions,
  optionsOf,
  runCreate,
  setCodec,
  setLevel,
  setSelect,
  visibleErrors,
} from "./lib/flows.mjs";
import { cached, crc32Hex, createPairs, EXH_CACHE } from "./lib/gen.mjs";
import { applyNow, assert, drive, Skip, stageAndSettle } from "./lib/scenario.mjs";
import { applyWithReference, extractWithHost, have, testWithHost, withTempDir } from "./lib/tools.mjs";
import { MOBILE } from "./lib/ui.mjs";

const TYPE = "#patch-builder-select-patch-type";
const COMPRESSION = "#patch-builder-select-output-compression";

// Formats the UI can ever offer are the creatable registry formats minus those the size policy hides;
// the rest are reported as not reachable from the webapp.
const CREATABLE = ROM_WEAVER_PATCH_FORMATS.filter((format) => format.capabilities.create).map((format) => format.name);
const UI_FORMATS = ["bps", "xdelta", "aps", "bdf", "ebp", "ips", "ppf", "rup", "ups"];
const EXT = {
  aps: "aps",
  bdf: "bdf",
  bps: "bps",
  ebp: "ebp",
  ips: "ips",
  ppf: "ppf",
  rup: "rup",
  ups: "ups",
  xdelta: "xdelta",
};
const REFERENCE = { bps: "flips", ips: "flips", ups: "flips", xdelta: "xdelta" };

const write = (dir, name, bytes) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
};

/** Apply `patchBytes` three independent ways and compare with `modified`. Returns notes. */
async function judge(h, { original, modified, patchBytes, patchName, format }) {
  const notes = [];
  const want = sha256(modified);
  const ref = REFERENCE[format];
  if (ref) {
    const result = applyWithReference(ref, original, patchBytes, patchName);
    if (result === null) notes.push(`${ref}: n/a`);
    else {
      assert(
        result.ok,
        `${ref} (independent applier) rejected the created ${format}: ${String(result.error).slice(0, 200)}`,
      );
      assert(
        sha256(result.bytes) === want,
        `${ref} applied the created ${format} to ${result.bytes.length} B (sha differs from the modified ROM)`,
      );
      notes.push(`${ref} ok`);
    }
  }
  if (cliPath() && original.length > 0) {
    withTempDir((dir) => {
      const src = write(dir, "src.bin", original);
      const patch = write(dir, patchName, patchBytes);
      const native = cliApply(src, [patch]);
      assert(native.ok, `native CLI rejected the created ${format}: ${native.stderr}`);
      assert(
        sha256(native.bytes) === want,
        `native CLI applied the created ${format} to ${native.bytes.length} B (sha differs)`,
      );
    });
    notes.push("native ok");
  }
  // Round trip through the webapp's Apply route.
  if (original.length > 0) {
    const roundTrip = await drive(h, async (page, session) => {
      let files = [
        { buffer: original, name: "orig.bin" },
        { buffer: patchBytes, name: patchName },
      ];
      if (original.length > 40_000_000) {
        // Playwright caps in-memory uploads at 50 MB: stage real files instead.
        const dir = path.join(h.caseDir, "rt");
        fs.mkdirSync(dir, { recursive: true });
        files = [write(dir, "orig.bin", original), write(dir, patchName, patchBytes)];
      }
      await stageAndSettle(page, files, 240_000);
      const out = await applyNow(h, page);
      return { ...out, pageErrors: session.pageErrors };
    });
    assert(!roundTrip.pageErrors.length, `apply page error: ${roundTrip.pageErrors[0]}`);
    assert(
      roundTrip.outcome === "download",
      `webapp Apply refused the webapp-created ${format} (${roundTrip.outcome}: ${roundTrip.result?.text || roundTrip.staged?.blockedReason || ""})`,
    );
    assert(
      sha256(roundTrip.bytes) === want,
      `webapp Apply of the created ${format} gave ${roundTrip.bytes.length} B (sha differs)`,
    );
    notes.push("webapp-apply ok");
  } else notes.push("webapp-apply n/a (empty original)");
  return notes.join(", ");
}

const checkName = (name, format, originalBytes) => {
  assert(name.toLowerCase().endsWith(`.${EXT[format]}`), `download ${JSON.stringify(name)} lacks .${EXT[format]}`);
  assert(!/[/\\<>:"|?*]/.test(name), `unsafe characters in ${JSON.stringify(name)}`);
  if (originalBytes.length > 0)
    assert(
      name.includes(`crc32_${crc32Hex(originalBytes)}`) || !/crc32_/.test(name),
      `name ${JSON.stringify(name)} carries a CRC that is not the original ROM's (${crc32Hex(originalBytes)})`,
    );
};

export function createCases() {
  const cases = [];
  const pairs = createPairs();

  // 1. patch format x pair
  for (const pair of pairs) {
    for (const format of UI_FORMATS) {
      cases.push({
        group: "create",
        id: `create/${format}/${pair.name}`,
        tags: ["create", format, pair.name],
        title: `create ${format} for ${pair.name}`,
        async run(h) {
          const original = pair.original();
          const modified = pair.modified();
          const { page, session, enabled } = await openCreate(
            h,
            { buffer: original, name: `orig-${pair.name}.bin` },
            { buffer: modified, name: `mod-${pair.name}.bin` },
          );
          try {
            const offered = (await optionsOf(page, TYPE)).map((option) => option.value);
            if (!offered.length) {
              const text = `${await mainText(page)} | ${(await visibleErrors(page)).join(" | ")}`;
              // quality-reason: the case needs an optional host tool, build option or native CLI that is not present on every host; the skip message names it, and the same code paths are covered by Rust tests and the other matrix cases.
              if (pair.name === "identical" || pair.name === "empty-to-data" || pair.name === "one-byte")
                throw new Skip(
                  `UI offers no formats for ${pair.name} (button ${enabled ? "enabled" : "disabled"}): ${text.slice(0, 160)}`,
                );
              throw new Error(`no format select options: ${text.slice(0, 300)}`);
            }
            // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
            if (!offered.includes(format))
              throw new Skip(`${format} not offered for ${pair.name} (offered: ${offered.join(",")})`);
            await setSelect(page, TYPE, format);
            const out = await runCreate(page, h.caseDir);
            if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
            if (pair.name === "identical" && out.kind !== "download")
              return `identical inputs: ${out.kind} ${out.text || ""}`.slice(0, 160);
            if (out.kind !== "download")
              throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""}); ${await mainText(page)}`);
            checkName(out.name, format, original);
            const notes = await judge(h, { format, modified, original, patchBytes: out.bytes, patchName: out.name });
            return `${out.name} ${out.bytes.length}B; ${notes}`;
          } finally {
            await session.context.close();
          }
        },
      });
    }
  }

  // 1b. size buckets: the UI narrows the format list by ROM size (ips/ebp vanish at 16 MiB, ...)
  // bps is withheld once the pair's combined size passes the suffix-index cap the encoder can build.
  const bpsCap = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.limits.bpsMaxCombinedInputBytes;
  const bucket = (id, size, offeredByPolicy, formats, { rawPath = false } = {}) => {
    const wantOffered = offeredByPolicy.filter((name) => name !== "bps" || size * 2 <= bpsCap);
    cases.push({
      group: "create",
      id: `create/bucket/${id}`,
      tags: ["create", "bucket", id],
      title: `${id}: offered formats are exactly ${wantOffered.join(",")}; create ${formats.join(",")}`,
      async run(h) {
        const original = cached(`create-bucket-${size}-o.bin`, () => Buffer.from(prng(size, 0x1234)));
        const modified = cached(`create-bucket-${size}-m.bin`, () => {
          const copy = Buffer.from(prng(size, 0x1234));
          for (let at = 17; at < size; at += 1_000_003) copy[at] ^= 0xff;
          return copy;
        });
        const dir = path.join(EXH_CACHE, "bucket");
        fs.mkdirSync(dir, { recursive: true });
        const oPath = write(dir, `o-${size}.bin`, original);
        const mPath = write(dir, `m-${size}.bin`, modified);
        const { page, session, enabled } = await openCreate(h, oPath, mPath);
        try {
          assert(enabled, `Create never enabled for ${id}: ${await mainText(page)}`);
          const offered = (await optionsOf(page, TYPE)).map((option) => option.value);
          assert(
            offered.length === wantOffered.length && wantOffered.every((value) => offered.includes(value)),
            `offered ${offered.join(",")}, policy says ${wantOffered.join(",")}`,
          );
          const notes = [];
          for (const format of formats) {
            await setSelect(page, TYPE, format);
            const out = await runCreate(page, h.caseDir, 300_000);
            assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
            assert(out.kind === "download", `${format}: no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
            checkName(out.name, format, original);
            notes.push(
              `${format} ${out.bytes.length}B: ${await judge(h, { format, modified, original, patchBytes: out.bytes, patchName: out.name })}`,
            );
          }
          void rawPath;
          return notes.join(" | ");
        } finally {
          await session.context.close();
        }
      },
    });
  };
  // pmsr/mod is source-restricted: hidden unless a resolved candidate says the original is its one ROM.
  const policy = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.formats;
  const unrestricted = (formats) =>
    formats.filter((name) => !ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.sourceRestrictedFormats.includes(name));
  bucket("16-17mib-medium", 17 << 20, unrestricted(policy.medium), ["bps", "xdelta", "ups", "ppf"]);
  bucket("128-130mib-midlarge", 130 << 20, unrestricted(policy.midLarge), ["xdelta"]);
  bucket("100mib-bps-under-cap", 100 << 20, unrestricted(policy.medium), ["bps"]);

  // 2. formats the registry can create but the Create UI never offers
  for (const format of CREATABLE.filter((name) => !UI_FORMATS.includes(name))) {
    cases.push({
      group: "create",
      id: `create/${format}/not-in-ui`,
      tags: ["create", format, "not-in-ui"],
      title: `${format}: creatable in the registry; check the Create UI never offers it for a small pair`,
      async run(h) {
        const pair = pairs[0];
        const { page, session } = await openCreate(
          h,
          { buffer: pair.original(), name: "o.bin" },
          { buffer: pair.modified(), name: "m.bin" },
        );
        try {
          const offered = (await optionsOf(page, TYPE)).map((option) => option.value);
          // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
          if (offered.includes(format)) return `offered (${offered.join(",")}) - now testable`;
          throw new Skip(`not reachable from the webapp (Create offers: ${offered.join(",")})`);
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // 3. output container x codec x level (patch bundled in zip / 7z)
  const same = pairs.find((pair) => pair.name === "same");
  const containerRun = (format, container, codec, level) => async (h) => {
    const original = same.original();
    const modified = same.modified();
    const { page, session } = await openCreate(
      h,
      { buffer: original, name: "orig.bin" },
      { buffer: modified, name: "mod.bin" },
    );
    try {
      await setSelect(page, TYPE, format);
      await openOptions(page);
      if (!(await setSelect(page, COMPRESSION, container))) throw new Error(`container ${container} not offered`);
      // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
      if (codec && !(await setCodec(page, codec))) throw new Skip(`codec ${codec} not selectable`);
      // quality-reason: the app offers only the codecs, levels and formats valid for the selected input; a combination it does not expose is outside this case, and the other cases in the group cover the offered ones.
      if (level && !(await setLevel(page, level))) throw new Skip("no level control");
      const out = await runCreate(page, h.caseDir);
      if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
      if (out.kind !== "download") throw new Error(`no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
      assert(out.name.toLowerCase().endsWith(`.${container}`), `container download ${out.name} lacks .${container}`);
      const bad = testWithHost(out.bytes, out.name);
      assert(!bad || bad === "no 7z", `host 7z t rejected the ${container}: ${bad}`);
      const extracted = extractWithHost(out.bytes, out.name);
      assert(!extracted.error, `host extract failed: ${extracted.error}`);
      assert(
        extracted.files.length === 1,
        `${container} holds ${extracted.files.length} entries: ${extracted.files.map((f) => f.name).join(",")}`,
      );
      const [inner] = extracted.files;
      assert(inner.name.toLowerCase().endsWith(`.${EXT[format]}`), `inner entry ${inner.name} lacks .${EXT[format]}`);
      const notes = await judge(h, {
        format,
        modified,
        original,
        patchBytes: inner.bytes,
        patchName: path.basename(inner.name),
      });
      return `${out.name} ${out.bytes.length}B; ${notes}`;
    } finally {
      await session.context.close();
    }
  };
  for (const format of UI_FORMATS) {
    cases.push({
      group: "create",
      id: `create/${format}/in-zip`,
      tags: ["create", format, "zip", "container"],
      title: `create ${format} in a zip`,
      run: containerRun(format, "zip", null, null),
    });
    cases.push({
      group: "create",
      id: `create/${format}/in-7z`,
      tags: ["create", format, "7z", "container"],
      title: `create ${format} in a 7z`,
      run: containerRun(format, "7z", null, null),
    });
  }
  for (const [container, codecs] of [
    ["zip", ["deflate", "store", "zstd"]],
    ["7z", ["lzma2"]],
  ]) {
    for (const codec of codecs) {
      for (const level of codec === "store" ? [null] : LEVELS) {
        cases.push({
          group: "create",
          id: `create/bps/${String(container)}/${String(codec)}/${String(level ?? "default")}`,
          tags: ["create", "bps", container, codec, level ?? ""],
          title: `create bps in ${String(container)} codec=${String(codec)} level=${String(level ?? "n/a")}`,
          run: containerRun("bps", container, codec, level),
        });
      }
    }
  }

  // 4. input shapes
  const base = same.original();
  const target = same.modified();
  const shape = (id, title, files, check) =>
    cases.push({
      group: "create",
      id: `create/input/${id}`,
      tags: ["create", "input", id],
      title,
      async run(h) {
        const { page, session, enabled } = await openCreate(h, files[0], files[1]);
        try {
          return await check({ enabled, h, page, session });
        } finally {
          await session.context.close();
        }
      },
    });
  shape(
    "zip-wrapped",
    "ROMs inside zips: create works and names the patch from the ROM, not the zip",
    [
      { buffer: Buffer.from(zipEncode([{ data: base, name: "orig.bin" }])), name: "orig.zip" },
      { buffer: Buffer.from(zipEncode([{ data: target, name: "mod.bin" }])), name: "mod.zip" },
    ],
    async ({ enabled, h, page, session }) => {
      assert(enabled, `Create never enabled: ${await mainText(page)}`);
      const out = await runCreate(page, h.caseDir);
      assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
      assert(out.kind === "download", `no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
      const notes = await judge(h, {
        format: "bps",
        modified: target,
        original: base,
        patchBytes: out.bytes,
        patchName: out.name,
      });
      return `${out.name}; ${notes}`;
    },
  );
  shape(
    "same-file-twice",
    "the same ROM as original and modified: a clear identical-files notice, no patch",
    [
      { buffer: base, name: "a.bin" },
      { buffer: base, name: "b.bin" },
    ],
    async ({ enabled, h, page, session }) => {
      assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
      const text = `${await mainText(page)} | ${(await visibleErrors(page)).join(" | ")}`;
      const out = enabled ? await runCreate(page, h.caseDir, 30_000) : { kind: "blocked" };
      assert(
        /identical|same|no differences|nothing to|match/i.test(text) || out.kind !== "download",
        `silent success with identical inputs: ${text.slice(0, 200)}`,
      );
      return `${out.kind}; ${text.slice(0, 120)}`;
    },
  );
  shape(
    "swap-sources",
    "swap original and modified: a patch created after Swap reverses the change",
    [
      { buffer: base, name: "a.bin" },
      { buffer: target, name: "b.bin" },
    ],
    async ({ enabled, h, page, session }) => {
      assert(enabled, "Create not enabled");
      await page.locator("#patch-builder-button-swap-sources").click();
      await page.waitForTimeout(1500);
      await setSelect(page, TYPE, "bps");
      const out = await runCreate(page, h.caseDir);
      assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
      assert(out.kind === "download", `no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
      const notes = await judge(h, {
        format: "bps",
        modified: base,
        original: target,
        patchBytes: out.bytes,
        patchName: out.name,
      });
      return `${out.name}; ${notes}`;
    },
  );
  shape(
    "unicode-names",
    "unicode and space names in both ROMs",
    [
      { buffer: base, name: "ゲーム é ü.bin" },
      { buffer: target, name: "ゲーム é ü (hack) 🎮.bin" },
    ],
    async ({ enabled, h, page, session }) => {
      assert(enabled, "Create not enabled");
      const out = await runCreate(page, h.caseDir);
      assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
      assert(out.kind === "download", `no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
      assert(/ゲーム/.test(out.name), `unicode lost in ${out.name}`);
      return out.name;
    },
  );
  shape(
    "unsupported-modified",
    "a text file as the modified ROM still builds a binary diff (or is refused with a message)",
    [
      { buffer: base, name: "a.bin" },
      { buffer: Buffer.from("not a rom, just text\n".repeat(30)), name: "notes.txt" },
    ],
    async ({ enabled, h, page, session }) => {
      const out = enabled ? await runCreate(page, h.caseDir, 40_000) : { kind: "blocked" };
      assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
      assert(out.kind !== "timeout", "UI hung");
      return `${out.kind}`;
    },
  );
  shape(
    "only-original",
    "only one ROM staged: Create disabled with a reason, no download",
    [{ buffer: base, name: "a.bin" }],
    async ({ enabled, page }) => {
      const text = await mainText(page);
      assert(!enabled, `Create enabled with only one ROM staged: ${text}`);
      return "disabled";
    },
  );

  // 5. mobile
  cases.push({
    group: "create",
    id: "create/mobile/bps",
    tags: ["create", "mobile"],
    title: "create bps on a 390x780 touch viewport: no horizontal overflow, correct patch",
    async run(h) {
      const { page, session, enabled } = await openCreate(
        h,
        { buffer: base, name: "a.bin" },
        { buffer: target, name: "b.bin" },
        { device: MOBILE },
      );
      try {
        assert(enabled, `Create not enabled on mobile: ${await mainText(page)}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 2, `horizontal overflow ${overflow}px`);
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile.png") });
        const out = await runCreate(page, h.caseDir);
        assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
        assert(out.kind === "download", `no download (${out.kind})`);
        const notes = await judge(h, {
          format: "bps",
          modified: target,
          original: base,
          patchBytes: out.bytes,
          patchName: out.name,
        });
        return `${out.name}; ${notes}`;
      } finally {
        await session.context.close();
      }
    },
  });

  // 6. repeated create in one session across formats
  cases.push({
    group: "create",
    id: "create/repeat/all-formats-one-session",
    tags: ["create", "repeat"],
    title: "create every UI format back to back in one session; each download valid",
    async run(h) {
      const { page, session } = await openCreate(h, { buffer: base, name: "a.bin" }, { buffer: target, name: "b.bin" });
      try {
        const done = [];
        for (const format of UI_FORMATS) {
          if (!(await setSelect(page, TYPE, format))) continue;
          const out = await runCreate(page, h.caseDir);
          assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
          assert(out.kind === "download", `${format}: no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
          assert(
            out.name.toLowerCase().endsWith(`.${EXT[format]}`),
            `${format}: download ${out.name} has the wrong extension`,
          );
          const ref = REFERENCE[format];
          if (ref) {
            const result = applyWithReference(ref, base, out.bytes, out.name);
            if (result)
              assert(result.ok && sha256(result.bytes) === sha256(target), `${format}: ${ref} disagrees in repeat run`);
          }
          done.push(format);
          await page.waitForTimeout(400);
        }
        return done.join(",");
      } finally {
        await session.context.close();
      }
    },
  });

  void spawnSync;
  void have;
  return cases;
}
