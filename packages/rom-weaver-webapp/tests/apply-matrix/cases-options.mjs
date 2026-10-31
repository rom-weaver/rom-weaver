// Feature/option cases on the Apply route: copier-header handling, download-after-patching behaviour,
// large input, cancel + retry, expected-checksum checks.
import fs from "node:fs";
import path from "node:path";
import { BLOBS, CACHE } from "../fixtures/apply-matrix/generate.mjs";
import * as enc from "../fixtures/apply-matrix/encoders.mjs";
import { cliApply } from "./lib/cli.mjs";
import { applyNow, assert, drive, expectDownload, fail, Skip, stageAndSettle } from "./lib/scenario.mjs";
import { snapshot, waitApplyEnabled } from "./lib/ui.mjs";

const read = (file) => fs.readFileSync(file);

/** Headerless data H (what the patch author used) and its edited target T. */
const H = enc.prng(32768, 0xc0de);
const T = (() => {
  const out = Uint8Array.from(H);
  out.set([1, 2, 3, 4, 5, 6, 7, 8], 0x1234);
  out[0x7000] ^= 0x55;
  return out;
})();
const SYSTEMS = {
  nes: {
    ext: "nes",
    header: Uint8Array.from([0x4e, 0x45, 0x53, 0x1a, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  },
  snes: { ext: "smc", header: new Uint8Array(512) }, // 32768 + 512 bytes: classic SMC size-modulus header
};

const headerCase = (system, mode, patchKind) => ({
  group: "header",
  id: `header/${system}/${patchKind}/${mode}`,
  tags: ["header", system, patchKind, mode],
  title: `${system} headered ROM + ${patchKind} patch built for the headerless data, header mode ${mode}`,
  async run(h) {
    const { ext, header } = SYSTEMS[system];
    const headered = enc.concat(header, H);
    const patchBytes = patchKind === "ips" ? enc.encodeIps(H, T) : enc.encodeBps(H, T);
    const romPath = path.join(h.caseDir, `game.${ext}`);
    const patchPath = path.join(h.caseDir, `fix.${patchKind}`);
    fs.writeFileSync(romPath, headered);
    fs.writeFileSync(patchPath, patchBytes);
    const native = cliApply(romPath, [patchPath], mode === "auto" ? [] : ["--patch-header", mode]);
    return drive(h, async (page, session) => {
      await stageAndSettle(page, [romPath, patchPath]);
      const select = page.locator("#rom-weaver-patch-header-mode-0");
      const offered = (await select.count()) > 0;
      if (mode !== "auto") {
        if (!offered)
          fail(
            { outcome: "n/a", staged: await snapshot(page) },
            "header handling select not offered for a headered ROM",
          );
        await select.selectOption(mode);
        await page.waitForTimeout(1500);
      }
      const out = await applyNow(h, page);
      out.pageErrors = session.pageErrors;
      out.after = await snapshot(page);
      await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "after.png") });
      if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
      const note = `select offered=${offered}; native=${native.ok === null ? "n/a" : native.ok ? "ok" : `refused: ${native.stderr}`}; webapp=${out.outcome}`;
      if (native.ok === null) return `${note} (no native CLI to compare)`;
      if (native.ok && out.outcome === "download") expectDownload(out, native.bytes, "output vs native");
      else if (native.ok !== (out.outcome === "download")) fail(out, `webapp/native disagree. ${note}`);
      return note;
    });
  },
});

export function optionCases({ manifest }) {
  const cases = [];
  for (const system of Object.keys(SYSTEMS))
    for (const patchKind of ["ips", "bps"])
      for (const mode of ["auto", "keep", "strip"]) cases.push(headerCase(system, mode, patchKind));

  // Download after patching: "With a button" must not auto-download; the button then downloads.
  cases.push({
    group: "options",
    id: "options/post-apply-download-with-button",
    tags: ["options", "download"],
    title: "Download after patching = With a button: apply makes no download, then the button does",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [path.join(BLOBS, "base.bin"), path.join(BLOBS, "bps-same.bps")]);
        const opener = page.getByText("Options", { exact: true }).last();
        await opener.click();
        await page.locator("#rom-weaver-select-post-apply-download").selectOption("show");
        let downloaded = false;
        page.on("download", () => {
          downloaded = true;
        });
        await waitApplyEnabled(page);
        await page.locator("#rom-weaver-button-apply").click();
        await page.waitForFunction(
          () => /Patched/i.test(document.getElementById("rom-weaver-button-apply")?.innerText || ""),
          undefined,
          { timeout: 60_000 },
        );
        await page.waitForTimeout(800);
        assert(!downloaded, "a download started even though 'With a button' is selected");
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30_000 }),
          page.locator("#rom-weaver-button-apply").click(),
        ]);
        const saved = path.join(h.caseDir, "dl.bin");
        await download.saveAs(saved);
        const out = { bytes: read(saved), outcome: "download", pageErrors: session.pageErrors };
        expectDownload(out, read(path.join(BLOBS, "target-same.bin")));
        return download.suggestedFilename();
      });
    },
  });

  // Large-ish input: the 40 MiB PMSR stand-in (cached outside git).
  const have = (name) => manifest.entries.some((entry) => entry.name === name && !entry.unavailable);
  const bigFiles = () => [path.join(CACHE, "pmsr-source.z64"), path.join(CACHE, "pmsr-large.mod")];
  cases.push({
    group: "options",
    id: "large/pmsr-40MiB",
    tags: ["large", "mod", "pmsr"],
    title: "40 MiB source + PMSR patch (CRC-gated format)",
    async run(h) {
      if (!have("pmsr-large.mod")) throw new Skip("pmsr-large.mod needs the native CLI to create");
      return drive(h, async (page, session) => {
        await stageAndSettle(page, bigFiles(), 180_000);
        const out = await applyNow(h, page, { timeout: 240_000 });
        out.pageErrors = session.pageErrors;
        out.after = await snapshot(page);
        expectDownload(out, read(path.join(CACHE, "pmsr-target.z64")));
        return `${out.name} ${out.bytes.length} B`;
      });
    },
  });
  cases.push({
    group: "options",
    id: "large/pmsr-40MiB-cancel-then-retry",
    tags: ["large", "cancel", "retry", "mod"],
    title: "start the 40 MiB apply, cancel mid-run, UI recovers, retry succeeds",
    async run(h) {
      if (!have("pmsr-large.mod")) throw new Skip("pmsr-large.mod needs the native CLI to create");
      return drive(h, async (page, session) => {
        await stageAndSettle(page, bigFiles(), 180_000);
        await page.getByText("Options", { exact: true }).last().click();
        await page.selectOption("#rom-weaver-select-output-format", "7z");
        await page.waitForTimeout(500);
        await waitApplyEnabled(page);
        const states = ["cancel button seen"];
        await page.locator("#rom-weaver-button-apply").click();
        // While busy the Apply button is replaced by a progress bar with a "Cancel applying" button.
        const target = page.locator("main button.progress-cancel[aria-label*='Cancel' i]").first();
        const seen = await target
          .waitFor({ state: "visible", timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "running.png") });
        if (!seen)
          fail(
            { outcome: "running", staged: await snapshot(page) },
            "no Cancel applying button appeared within 15 s of clicking Apply",
          );
        await target.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "cancelled.png") });
        const afterCancel = await snapshot(page);
        const out = await applyNow(h, page, { timeout: 300_000 });
        out.pageErrors = session.pageErrors;
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (out.outcome !== "download")
          fail(
            { ...out, after: await snapshot(page) },
            `retry after cancel gave ${out.outcome}; after-cancel apply label=${afterCancel.applyText}`,
          );
        return `retry ${out.name} ${out.bytes.length} B; after-cancel label=${afterCancel.applyText}; ${states.join(",")}`;
      });
    },
  });
  void Skip;
  return cases;
}
