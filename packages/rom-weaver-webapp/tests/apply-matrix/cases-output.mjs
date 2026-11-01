// Output-side cases: every compression/format offered in the Apply output card, every level profile,
// naming edge cases, re-apply after option changes.
import fs from "node:fs";
import path from "node:path";
import { BLOBS } from "../fixtures/apply-matrix/generate.mjs";
import { sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import { cliExtract } from "./lib/cli.mjs";
import { applyNow, assert, drive, expectDownload, fail, Skip, stageAndSettle } from "./lib/scenario.mjs";

const read = (file) => fs.readFileSync(file);
const base = path.join(BLOBS, "base.bin");
const patch = path.join(BLOBS, "bps-same.bps");
const target = () => read(path.join(BLOBS, "target-same.bin"));

const LEVELS = ["min", "very-low", "low", "medium", "high", "very-high", "max"];
const MAGIC = {
  "7z": [0x37, 0x7a, 0xbc, 0xaf],
  chd: [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44],
  zip: [0x50, 0x4b],
};

async function openOptions(page) {
  const expanded = await page
    .locator("#rom-weaver-select-output-format")
    .locator("xpath=ancestor::*[contains(@class,'card') or self::section][1]")
    .getByText("Options", { exact: true })
    .first();
  if (await expanded.count()) await expanded.click();
  await page.waitForTimeout(300);
}
const setFormat = async (page, value) => {
  await page.selectOption("#rom-weaver-select-output-format", value);
  await page.waitForTimeout(500);
};
const setLevel = async (page, value) => {
  await page.getByLabel("Compression level", { exact: true }).selectOption(value);
  await page.waitForTimeout(300);
};
const setCodec = async (page, codec) => {
  const combo = page.getByRole("combobox", { name: /codec/i }).first();
  await combo.click();
  await page
    .locator("[role=option]", { hasText: new RegExp(`^${codec}$`) })
    .first()
    .click();
  await page.waitForTimeout(300);
};

/** Verify the produced artifact: magic bytes always, content via the native CLI when built. */
function verifyArtifact(out, format, expected) {
  if (out.pageErrors?.length) throw new Error(`page error ${out.pageErrors[0]}`);
  if (out.outcome !== "download") fail(out, `no download (${out.outcome})`);
  if (format !== "none") {
    const magic = MAGIC[format];
    assert(
      magic.every((byte, i) => out.bytes[i] === byte),
      `${format} magic wrong: ${Buffer.from(out.bytes.subarray(0, 8)).toString("hex")}`,
    );
    assert(out.name.toLowerCase().endsWith(`.${format}`), `download name ${out.name} lacks .${format}`);
  }
  if (format === "none") return expectDownload(out, expected);
  const extracted = cliExtract(out.bytes, out.name);
  if (!extracted) return "magic-only (no native CLI to extract)";
  if (extracted.error) fail(out, `native CLI could not read the ${format} the webapp wrote: ${extracted.error}`);
  const match = extracted.files.some((file) => sha256(file.bytes) === sha256(expected));
  if (!match)
    fail(out, `${format} content mismatch: ${extracted.files.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}`);
  return `verified via native extract (${extracted.files.length} file)`;
}

const fmtCase = ({ format, codec, level, id }) => ({
  group: "output-format",
  id: `output/${format}/${codec ?? "default"}/${level ?? "default"}${id ?? ""}`,
  tags: ["output", format, codec ?? "", level ?? ""],
  title: `output ${format} codec=${codec ?? "default"} level=${level ?? "default"}`,
  async run(h) {
    return drive(h, async (page, session) => {
      await stageAndSettle(page, [base, patch]);
      await openOptions(page);
      await setFormat(page, format);
      if (codec) await setCodec(page, codec);
      if (level) await setLevel(page, level);
      const out = await applyNow(h, page);
      out.pageErrors = session.pageErrors;
      await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "after.png") });
      return verifyArtifact(out, format, target());
    });
  },
});

export function outputCases() {
  const cases = [];
  cases.push(fmtCase({ format: "none" }));
  for (const level of LEVELS) cases.push(fmtCase({ codec: "deflate", format: "zip", level }));
  for (const codec of ["store", "zstd"])
    for (const level of ["min", "max"]) cases.push(fmtCase({ codec, format: "zip", level }));
  for (const level of LEVELS) cases.push(fmtCase({ codec: "lzma2", format: "7z", level }));
  for (const level of ["min", "medium", "max"]) cases.push(fmtCase({ format: "chd", level }));

  // Naming edge cases (typed into the output name field).
  const names = {
    unicode: "Ünïcödé ゲーム 🎮",
    "no-extension-typed": "plainname",
    "typed-bin-extension": "typed.bin",
    dots: "a.b.c.d",
    "leading-dot": ".hidden",
    long: "n".repeat(180),
    "spaces-edges": "  spaced name  ",
    "reserved-chars": 'we<ir>d:na"me|?*',
    "path-separators": "dir/sub\\name",
    empty: "",
  };
  for (const [key, value] of Object.entries(names)) {
    cases.push({
      group: "naming",
      id: `naming/${key}`,
      tags: ["naming", key],
      title: `output name ${JSON.stringify(value.slice(0, 40))}`,
      async run(h) {
        return drive(h, async (page, session) => {
          await stageAndSettle(page, [base, patch]);
          const field = page.locator("#rom-weaver-input-output-file-name");
          await field.fill(value);
          await field.blur();
          await page.waitForTimeout(500);
          const out = await applyNow(h, page);
          out.pageErrors = session.pageErrors;
          if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
          if (out.outcome !== "download") fail(out, `no download for name ${JSON.stringify(value)}`);
          expectDownload(out, target());
          const name = out.name;
          assert(name.length > 0 && !/[/\\]/.test(name), `unsafe download name ${JSON.stringify(name)}`);
          assert(/\.bin$/i.test(name), `download name lacks .bin: ${JSON.stringify(name)}`);
          assert(!/\.bin\.bin$/i.test(name), `double extension: ${name}`);
          assert(!/[<>:"|?*]/.test(name), `reserved characters kept: ${name}`);
          return `name=${JSON.stringify(name)}`;
        });
      },
    });
  }
  cases.push({
    group: "naming",
    id: "naming/unicode-rom-and-patch-file-names",
    tags: ["naming", "unicode"],
    title: "unicode ROM and patch file names flow into the default output name",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [
          { buffer: read(base), name: "ゲーム é.bin" },
          { buffer: read(patch), name: "パッチ ü.bps" },
        ]);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        expectDownload(out, target());
        assert(out.name.includes("ゲーム"), `unicode lost in ${out.name}`);
        return out.name;
      });
    },
  });
  cases.push({
    group: "naming",
    id: "naming/rom-without-extension",
    tags: ["naming", "no-extension"],
    title: "ROM file with no extension",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [{ buffer: read(base), name: "romnoext" }, patch]);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        expectDownload(out, target());
        return out.name;
      });
    },
  });
  cases.push({
    group: "naming",
    id: "naming/duplicate-patch-dropped-twice",
    tags: ["naming", "duplicate"],
    title: "the same patch dropped twice: no page error and no hang (download contents not checked)",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, patch, { buffer: read(patch), name: "bps-same.bps" }]);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (out.outcome === "timeout") fail(out, "hang");
        return `outcome=${out.outcome}`;
      });
    },
  });

  // Re-apply after changing options on the same page.
  cases.push({
    group: "reapply",
    id: "reapply/format-switch-bin-zip-7z-bin",
    tags: ["reapply", "output", "zip", "7z"],
    title: "apply, switch output format, apply again: each download correct",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, patch]);
        await openOptions(page);
        const notes = [];
        for (const format of ["none", "zip", "7z", "none"]) {
          await setFormat(page, format);
          const out = await applyNow(h, page);
          out.pageErrors = session.pageErrors;
          notes.push(`${format}:${String(verifyArtifact(out, format, target()))}`.slice(0, 40));
          await page.waitForTimeout(400);
        }
        return notes.join(" ");
      });
    },
  });
  cases.push({
    group: "reapply",
    id: "reapply/rename-after-apply",
    tags: ["reapply", "naming"],
    title: "apply, rename output, apply again",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, patch]);
        const first = await applyNow(h, page);
        first.pageErrors = session.pageErrors;
        expectDownload(first, target(), "first");
        const field = page.locator("#rom-weaver-input-output-file-name");
        await field.fill("renamed-output");
        await field.blur();
        await page.waitForTimeout(600);
        const second = await applyNow(h, page);
        second.pageErrors = session.pageErrors;
        expectDownload(second, target(), "second");
        assert(second.name === "renamed-output.bin", `second download name ${second.name}, wanted renamed-output.bin`);
        return `${first.name} -> ${second.name}`;
      });
    },
  });
  cases.push({
    group: "reapply",
    id: "reapply/swap-patch-after-apply",
    tags: ["reapply", "replace-patch"],
    title:
      "apply with bps, then drop an ips on the same page and apply again: first output exact, second informational",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, patch]);
        const first = await applyNow(h, page);
        first.pageErrors = session.pageErrors;
        expectDownload(first, target(), "first");
        await stageAndSettle(page, [path.join(BLOBS, "ips-grow.ips")]);
        const second = await applyNow(h, page);
        second.pageErrors = session.pageErrors;
        if (second.pageErrors.length) fail(second, `page error ${second.pageErrors[0]}`);
        if (second.outcome === "timeout") fail(second, "hang on second apply");
        if (second.outcome === "download") return `second=${second.bytes.length}B chain-or-replace (informational)`;
        return `second outcome ${second.outcome}`;
      });
    },
  });
  void Skip;
  return cases;
}
