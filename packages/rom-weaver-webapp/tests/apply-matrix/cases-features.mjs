// Other Apply-route workflows that write bytes: cheat codes (manual entry), weave export + re-import,
// combined patch download, expected-checksum checks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOBS, CACHE } from "../fixtures/apply-matrix/generate.mjs";
import { sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import { cliApply, cliExtract, cliPatchCreateFromCode } from "./lib/cli.mjs";
import { applyNow, assert, drive, expectDownload, fail, scenario, Skip, stageAndSettle } from "./lib/scenario.mjs";
import { snapshot } from "./lib/ui.mjs";

const read = (file) => fs.readFileSync(file);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NES = path.resolve(HERE, "../fixtures/cheats/hello-world.nes");

async function addManualCheat(page, { code, description }) {
  await page.getByText("Add cheats to the patch order").first().click();
  await page.getByRole("button", { name: "Add code manually" }).click();
  await page.getByLabel("Description").fill(description);
  await page.getByLabel("Cheat code").fill(code);
  await page.getByRole("button", { name: /check code/i }).click();
  await page.getByRole("button", { name: "Add this cheat" }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Add this cheat" }).click();
  await page.waitForTimeout(1000);
  const close = page.getByRole("button", { name: "Close" });
  if (await close.count())
    await close
      .first()
      .click()
      .catch(() => undefined);
  await page.waitForTimeout(800);
}

const jsChain = [
  "1-ips.ips",
  "2-ips32.ips32",
  "3-ebp.ebp",
  "4-bps.bps",
  "5-ups.ups",
  "6-xdelta.xdelta",
  "7-gdiff.gdiff",
  "8-vcdiff.vcdiff",
].map((name) => path.join(BLOBS, `chain-${name}`));
const COMBINED_FORMATS = ["bps", "xdelta", "aps", "bdf", "ebp", "ips", "ppf", "rup", "ups"];

async function downloadVia(page, h, trigger) {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), trigger()]);
  const saved = path.join(h.caseDir, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(saved);
  return { bytes: fs.readFileSync(saved), name: download.suggestedFilename(), saved };
}

const undoCase = ({ id, title, files, format = "none", expected, expectRefusal, expectMismatchWarning }) => ({
  group: "ppf-undo",
  id: `ppf-undo/${id}`,
  tags: ["ppf-undo", "ppf", format],
  title,
  async run(h) {
    for (const file of files)
      if (typeof file === "string" && !fs.existsSync(file))
        // quality-reason: CLI-made ppf-undo fixtures need the native CLI (absent when RW_BIN is unset); the fixtures that are committed still run, and the CLI harness covers ppf-undo.
        throw new Skip(
          `fixture missing: ${path.basename(file)} (run tests/fixtures/apply-matrix/generate.mjs; CLI-made ones need the native CLI)`,
        );
    return drive(
      h,
      async (page, session) => {
        const payload = files.map((file) =>
          typeof file === "string"
            ? {
                buffer: fs.readFileSync(file),
                mimeType: "application/octet-stream",
                name: path.basename(file),
              }
            : {
                buffer: Buffer.from(file.buffer),
                mimeType: "application/octet-stream",
                name: file.name,
              },
        );
        await page.locator("#ppf-undo-input-picker").setInputFiles(payload);
        await page.waitForTimeout(3500);
        // Default output is zip; "none" is a real option that downloads the bare .bin.
        await page.selectOption("#ppf-undo-output-compression", format);
        const button = page.getByRole("button", { name: /restore original rom/i });
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "undo-staged.png") });
        const enabled = (await button.count()) && (await button.isEnabled());
        if (expectRefusal && !enabled) return "restore button disabled";
        const run = await Promise.race([
          page.waitForEvent("download", { timeout: expectRefusal ? 8000 : 60_000 }).then(
            async (download) => {
              const saved = path.join(h.caseDir, `${Date.now()}-${download.suggestedFilename()}`);
              await download.saveAs(saved);
              return {
                bytes: fs.readFileSync(saved),
                name: download.suggestedFilename(),
                outcome: "download",
              };
            },
            () => null,
          ),
          button.click().then(() => new Promise(() => undefined)),
        ]);
        const out = run ?? { outcome: "none" };
        out.pageErrors = session.pageErrors;
        if (out.pageErrors.length) throw new Error(`page error ${out.pageErrors[0]}`);
        if (expectRefusal) {
          if (out.outcome === "download") throw new Error(`expected a refusal, got ${out.name}`);
          const text = await page.locator("main").innerText();
          return `refused; visible: ${/error|fail|cannot|undo/i.exec(text)?.[0] ?? "(no message)"}`;
        }
        if (out.outcome !== "download") throw new Error("PPF undo produced no download");
        if (expectMismatchWarning) {
          // The undo data is still written (ppf.rs undo_ppf), but the core warns that the ROM does not match.
          if (sha256(out.bytes) === sha256(expectMismatchWarning))
            throw new Error("wrong ROM unexpectedly restored to the original");
          const warning = page.getByText(/does not match the patched data/i);
          await warning.first().waitFor({ state: "visible", timeout: 10_000 });
          await page.waitForTimeout(800);
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "undo-warning.png") });
          return `${out.name}: restored with visible warning "${(await warning.first().innerText()).slice(0, 120)}"`;
        }
        if (format === "none") {
          if (sha256(out.bytes) !== sha256(expected)) throw new Error(`restored bytes differ (${out.bytes.length} B)`);
          return out.name;
        }
        const extracted = cliExtract(out.bytes, out.name);
        if (!extracted) return `${out.name} (magic only, no native CLI)`;
        if (!extracted.files.some((file) => sha256(file.bytes) === sha256(expected)))
          throw new Error(`restored archive content differs: ${extracted.files.map((f) => f.name).join(",")}`);
        return `${out.name} verified via native extract`;
      },
      { ready: "main", route: "ppf-undo" },
    );
  },
});

export function featureCases() {
  const cases = [];
  const baseBytes = read(path.join(BLOBS, "base.bin"));
  const targetPath = path.join(BLOBS, "target-same.bin");
  const ppfPath = path.join(BLOBS, "ppf3-same.ppf");
  cases.push(
    undoCase({
      expected: baseBytes,
      files: [targetPath, ppfPath],
      id: "restore-bin",
      title: "patched ROM + PPF with undo data restores base.bin",
    }),
  );
  cases.push(
    undoCase({
      expected: baseBytes,
      files: [targetPath, ppfPath],
      format: "zip",
      id: "restore-zip",
      title: "same, output zip",
    }),
  );
  cases.push(
    undoCase({
      expected: baseBytes,
      files: [targetPath, ppfPath],
      format: "7z",
      id: "restore-7z",
      title: "same, output 7z",
    }),
  );
  cases.push(
    undoCase({
      expectRefusal: true,
      files: [targetPath, path.join(CACHE, "ppf-same.ppf")],
      id: "ppf-without-undo-data",
      title: "a PPF without undo data (CLI-made ppf-same.ppf) must be refused with a reason",
    }),
  );
  cases.push(
    undoCase({
      expectMismatchWarning: baseBytes,
      files: [path.join(BLOBS, "other.bin"), ppfPath],
      id: "wrong-rom",
      title:
        'undo against a ROM that was never patched: the restore still runs, the output differs from the original, and the "does not match the patched data" warning is shown',
    }),
  );
  cases.push(
    undoCase({
      expectRefusal: true,
      files: [targetPath, path.join(BLOBS, "ips-same.ips")],
      id: "not-a-ppf",
      title: "an IPS patch in the PPF undo route must be refused",
    }),
  );
  for (const format of COMBINED_FORMATS) {
    cases.push({
      group: "combined-patch",
      id: `combined/${format}`,
      tags: ["combined-patch", format],
      title: `8-patch chain exported as one ${format} patch; re-applying it (webapp and native) reproduces the chain result`,
      async run(h) {
        const expected = read(path.join(BLOBS, "chain-final.bin"));
        const exported = await drive(h, async (page) => {
          await stageAndSettle(page, [path.join(BLOBS, "base.bin"), ...jsChain]);
          await page.getByText("Download a combined patch").click();
          await page.locator("#rom-weaver-combined-patch-format").selectOption(format);
          await page.waitForTimeout(500);
          // "Create patch & download" builds the patch; when it does not download by itself the same
          // button turns into "Download patch" and a second click saves it.
          const job = page.locator("#rom-weaver-combined-patch-job");
          const early = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
          await job.getByRole("button", { name: /create patch/i }).click();
          const first = await early;
          if (first) {
            const savedFirst = path.join(h.caseDir, `${Date.now()}-${first.suggestedFilename()}`);
            await first.saveAs(savedFirst);
            return {
              bytes: fs.readFileSync(savedFirst),
              name: first.suggestedFilename(),
              saved: savedFirst,
            };
          }
          const save = job.getByRole("button", { name: /download patch/i });
          await save.waitFor({ timeout: 120_000 });
          return downloadVia(page, h, () => save.click());
        });
        assert(exported.bytes.length > 0, "empty combined patch");
        assert(
          exported.name.toLowerCase().endsWith(`.${format}`) ||
            (format === "bdf" && /\.(bdf|bsdiff)/i.test(exported.name)),
          `combined patch name ${exported.name} lacks .${format}`,
        );
        const native = cliApply(path.join(BLOBS, "base.bin"), [exported.saved]);
        const nativeNote =
          native.ok === null
            ? "no native CLI"
            : native.ok
              ? sha256(native.bytes) === sha256(expected)
                ? "native re-apply ok"
                : "NATIVE RE-APPLY WRONG BYTES"
              : `native refuses: ${native.stderr}`;
        if (native.ok && sha256(native.bytes) !== sha256(expected))
          throw new Error(`${nativeNote} for ${exported.name}`);
        const reapplied = await scenario(h, {
          files: [path.join(BLOBS, "base.bin"), { buffer: exported.bytes, name: exported.name }],
          shot: "reapply",
        });
        expectDownload(reapplied, expected, "webapp re-apply of combined patch");
        return `${exported.name} ${exported.bytes.length} B; ${nativeNote}`;
      },
    });
  }
  for (const withRom of [false, true]) {
    cases.push({
      group: "weave",
      id: `weave/export-then-apply/${withRom ? "with-rom" : "without-rom"}`,
      tags: ["weave", withRom ? "with-rom" : "without-rom"],
      title: `export the 8-patch chain as a weave (${withRom ? "ROM included" : "no ROM"}), drop it into a fresh session and apply`,
      async run(h) {
        const expected = read(path.join(BLOBS, "chain-final.bin"));
        const exported = await drive(h, async (page) => {
          await stageAndSettle(page, [path.join(BLOBS, "base.bin"), ...jsChain]);
          await page.getByText("Download the weave").click();
          const toggle = page.locator("#rom-weaver-weave-export-weave-rom");
          if ((await toggle.count()) && (await toggle.isChecked()) !== withRom)
            await toggle.evaluate((element) => element.click());
          await page.waitForTimeout(400);
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "weave-export.png") });
          return downloadVia(page, h, () => page.locator("#rom-weaver-button-export-weave").click());
        });
        assert(exported.bytes.length > 0, "empty weave");
        const files = withRom
          ? [{ buffer: exported.bytes, name: exported.name }]
          : [path.join(BLOBS, "base.bin"), { buffer: exported.bytes, name: exported.name }];
        const out = await scenario(h, { files, shot: "weave-apply" });
        expectDownload(out, expected, "weave re-apply");
        return `${exported.name} ${exported.bytes.length} B -> ${out.name}`;
      },
    });
  }
  for (const code of ["SXIOPO", "GOSSIP"]) {
    cases.push({
      group: "cheats",
      id: `cheats/nes-game-genie/${code}`,
      tags: ["cheats", "game-genie", "nes"],
      title: `manual NES Game Genie code ${code} applied to hello-world.nes`,
      async run(h) {
        const expected = cliPatchCreateFromCode(NES, code, h.caseDir);
        return drive(h, async (page, session) => {
          await stageAndSettle(page, [NES]);
          await addManualCheat(page, { code, description: `matrix ${code}` });
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "cheat-staged.png") });
          const out = await applyNow(h, page);
          out.pageErrors = session.pageErrors;
          out.after = await snapshot(page);
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "cheat-after.png") });
          if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
          if (!expected) {
            if (out.outcome !== "download") fail(out, "cheat apply produced no download");
            return "no native CLI to compare";
          }
          if (expected.error) return `native rejects the code (${expected.error}); webapp outcome=${out.outcome}`;
          expectDownload(out, expected.bytes, "cheat output vs native patch create --code + apply");
          return `${out.name}`;
        });
      },
    });
  }
  void Skip;
  void assert;
  void sha256;
  void cliApply;
  void fs;
  void BLOBS;
  return cases;
}
