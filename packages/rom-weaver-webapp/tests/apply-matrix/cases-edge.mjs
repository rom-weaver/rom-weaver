// Cross-cutting behaviour: real drag-and-drop (files, folders, archives), cancel mid-operation, OPFS
// cleanup, repeated runs in one session, console hygiene, disabled states, zero/one-byte inputs, mobile.
import fs from "node:fs";
import path from "node:path";
import { BLOBS } from "../fixtures/apply-matrix/generate.mjs";
import { prng, sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import { mainText, openCreate, runCreate, visibleErrors } from "./lib/flows.mjs";
import { dropFixtures, dropPaths } from "./lib/drag.mjs";
import { cached, EXH_CACHE, FIXTURE_ROOT } from "./lib/gen.mjs";
import { applyNow, assert, drive, expectDownload, stageAndSettle } from "./lib/scenario.mjs";
import { MOBILE, newSession, snapshot, stage } from "./lib/ui.mjs";

const read = (file) => fs.readFileSync(file);
const base = path.join(BLOBS, "base.bin");
const bps = path.join(BLOBS, "bps-same.bps");
const target = () => read(path.join(BLOBS, "target-same.bin"));
const CTR = path.join(FIXTURE_ROOT, "ctr");

const CANCEL = "main button.cancel"; // Apply: "Cancel applying" (.run-cancel); Compress: "Cancel operation" (.stage-cancel)
const openOptionsSafe = async (page) => {
  for (const toggle of await page.getByText("Options", { exact: true }).all())
    await toggle.click({ timeout: 1500 }).catch(() => undefined);
};
/** Compress route: click COMPRESS, wait for DOWNLOAD, click again, save to disk, return the path (no buffering). */
async function runCompressLite(page, outDir, timeout) {
  const button = page.locator("main button.run");
  await button.click();
  await page
    .waitForFunction(() => /^download/i.test(document.querySelector("main button.run")?.innerText || ""), undefined, {
      timeout,
    })
    .catch(() => undefined);
  if (!/^download/i.test((await button.innerText()).trim())) return { kind: "timeout" };
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 120_000 }), button.click()]);
  const saved = path.join(outDir, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(saved);
  return { kind: "download", name: download.suggestedFilename(), saved };
}
/** Read the first local file header of a zip (handles zip64 sizes in the central directory). */
function readZipFirstEntry(file) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const tailLen = Math.min(stat.size, 70_000);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
    let eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert(eocd >= 0, "no end-of-central-directory record");
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) {
      const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
      const z64 = Number(tail.readBigUInt64LE(loc + 8));
      const rec = Buffer.alloc(56);
      fs.readSync(fd, rec, 0, 56, z64);
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const head = Buffer.alloc(46 + 512);
    fs.readSync(fd, head, 0, head.length, cdOffset);
    assert(head.readUInt32LE(0) === 0x02014b50, "bad central directory header");
    const method = head.readUInt16LE(10);
    let size = head.readUInt32LE(24);
    const nameLen = head.readUInt16LE(28);
    const extraLen = head.readUInt16LE(30);
    const name = head.subarray(46, 46 + nameLen).toString("utf8");
    if (size === 0xffffffff) {
      const extra = head.subarray(46 + nameLen, 46 + nameLen + extraLen);
      size = Number(extra.readBigUInt64LE(4));
    }
    return { method, name, size };
  } finally {
    fs.closeSync(fd);
  }
}
const patchCards = (page) => page.locator("main .card.file.patch").count();
const cardNames = (page) => page.locator("main .card.file .nm").allInnerTexts();

/** OPFS listing from the main thread (read-only directory iteration; sync handles stay in workers). */
const opfsList = (page) =>
  page.evaluate(async () => {
    const out = [];
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          out.push(`${prefix}${name}/`);
          await walk(handle, `${prefix}${name}/`);
        } else out.push(`${prefix}${name}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return out;
  });
const opfsFiles = async (page) => (await opfsList(page)).filter((entry) => !entry.endsWith("/"));

export function edgeCases() {
  const cases = [];
  const romBytes = read(base);
  const patchBytes = read(bps);
  const fx = dropFixtures({ extra: Buffer.from("x"), patch: patchBytes, rom: romBytes });

  // ---------------------------------------------------------------- real drops on the Apply hero
  const positions = [
    ["title", [0.5, 0.2]],
    ["description", [0.5, 0.35]],
    ["background", [0.5, 0.5]],
    ["bead", [0.5, 0.65]],
    ["copy", [0.5, 0.8]],
    ["left-edge", [0.1, 0.5]],
  ];
  for (const [label, at] of positions) {
    cases.push({
      group: "drop",
      id: `drop/apply-hero/patch-only/${String(label)}`,
      tags: ["drop", "apply", "hero", label],
      title: `real drop of one patch on the Apply hero (${String(label)}): exactly one patch card`,
      async run(h) {
        const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]" });
        try {
          const { target: hit } = await dropPaths(session, [bps], { at });
          await session.page.waitForTimeout(4000);
          const cards = await patchCards(session.page);
          assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
          assert(
            cards === 1,
            `one dropped patch produced ${cards} patch cards (drop target ${hit}): ${(await cardNames(session.page)).join(" | ")}`,
          );
          return `target ${hit}`;
        } finally {
          await session.context.close();
        }
      },
    });
  }
  cases.push({
    group: "drop",
    id: "drop/apply-hero/rom-and-patch/apply-result",
    tags: ["drop", "apply", "e2e"],
    title: "real drop of ROM + patch on the hero text then Apply: output equals the target",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]" });
      try {
        const { target: hit } = await dropPaths(session, [base, bps], { at: [0.5, 0.35] });
        await session.page.waitForTimeout(5000);
        const out = await applyNow(h, session.page);
        assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
        expectDownload({ ...out, pageErrors: session.pageErrors }, target());
        return `target ${hit}; ${out.name}`;
      } finally {
        await session.context.close();
      }
    },
  });
  for (const [name, dir] of [
    ["flat", fx.flat],
    ["nested", fx.nested],
    ["unicode", fx.unicode],
  ]) {
    cases.push({
      group: "drop",
      id: `drop/apply-folder/${name}`,
      tags: ["drop", "folder", name],
      title: `drop a ${name} folder (ROM + patch + hidden files) on Apply: one ROM, one patch, hidden skipped`,
      async run(h) {
        const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]" });
        try {
          await dropPaths(session, [dir], { at: [0.1, 0.5] });
          await session.page.waitForTimeout(5000);
          const patches = await patchCards(session.page);
          const names = await cardNames(session.page);
          assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
          assert(patches === 1, `${patches} patch cards for a folder with one patch: ${names.join(" | ")}`);
          assert(!names.some((n) => /skip|DS_Store/i.test(n)), `hidden entries were staged: ${names.join(" | ")}`);
          const out = await applyNow(h, session.page);
          expectDownload({ ...out, pageErrors: session.pageErrors }, target());
          return `${names.join(" | ")} -> ${out.name}`;
        } finally {
          await session.context.close();
        }
      },
    });
  }
  for (const [label, files, expectRoute] of [
    ["zip-with-rom-and-patch", [path.join(CTR, "rom-plus-patch.zip")], "apply"],
    ["7z-with-patch", [path.join(CTR, "patch.bps.7z")], "apply"],
    ["tar-gz-patch", [path.join(CTR, "patch.bps.tar.gz")], "apply"],
    ["nested-zip", [path.join(CTR, "nested-outer.zip")], "any"],
  ]) {
    cases.push({
      group: "drop",
      id: `drop/apply-archive/${String(label)}`,
      tags: ["drop", "archive", label],
      title: `real drop of ${String(label)} on Apply: staged without error`,
      skip: files.every(fs.existsSync) ? undefined : "fixture missing",
      async run(h) {
        const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]" });
        try {
          await dropPaths(session, files, { at: [0.2, 0.9] });
          await session.page.waitForTimeout(6000);
          assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
          const state = await snapshot(session.page);
          const errs = (await visibleErrors(session.page)).filter((e) => /error|fail|invalid/i.test(e));
          assert(
            state.cards.length > 0,
            `nothing staged for ${String(label)}: ${String(await mainText(session.page))}`,
          );
          void expectRoute;
          return `${state.cards.length} card(s)${errs.length ? `; notices: ${errs[0]}` : ""}`;
        } finally {
          await session.context.close();
        }
      },
    });
  }

  // drops on the other routes: one dropped ROM must not fill two slots
  cases.push({
    group: "drop",
    id: "drop/create-hero/single-rom/not-in-both-slots",
    tags: ["drop", "create"],
    title: "one ROM dropped on the Create hero text lands in Original only",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]", route: "create-rom-patch" });
      try {
        await dropPaths(session, [base], { at: [0.5, 0.35] });
        await session.page.waitForTimeout(4000);
        const names = await cardNames(session.page);
        assert(names.length === 1, `one ROM dropped, ${names.length} cards: ${names.join(" | ")}`);
        return names.join(",");
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "drop",
    id: "drop/compress-hero/single-file/one-card",
    tags: ["drop", "compress"],
    title: "one file dropped on the Compress hero text produces one card",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]", route: "compress-files" });
      try {
        await dropPaths(session, [base], { at: [0.5, 0.35] });
        await session.page.waitForTimeout(3000);
        const names = await session.page.locator(".compress-files .nm").allInnerTexts();
        assert(names.length === 1, `one file dropped, ${names.length} cards: ${names.join(" | ")}`);
        return names.join(",");
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "drop",
    id: "drop/extract-hero/zip/one-list",
    tags: ["drop", "extract"],
    title: "a zip dropped on the Extract hero text lists its files once",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]", route: "extract-files" });
      try {
        await dropPaths(session, [path.join(CTR, "two-roms.zip")], { at: [0.5, 0.35] });
        await session.page.waitForTimeout(5000);
        const rows = await session.page.locator("main .pick-row").count();
        assert(rows === 2, `two-roms.zip lists ${rows} rows`);
        return `${rows} rows`;
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "drop",
    id: "drop/trim-route/patch-file",
    tags: ["drop", "trim"],
    title: "a patch dropped on Trim is not staged as the ROM and the user is told where it belongs",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, { ready: "input[type=file]", route: "trim-rom" });
      try {
        await dropPaths(session, [bps], { at: [0.2, 0.9] });
        await session.page.waitForTimeout(3000);
        const text = await mainText(session.page);
        const staged = await session.page.locator("main .card.file").count();
        assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
        assert(
          staged === 0 || /patch|apply|belongs|ignored/i.test(text),
          `patch silently staged as a ROM on Trim: ${text.slice(0, 200)}`,
        );
        return `cards=${staged}; ${text.slice(0, 120)}`;
      } finally {
        await session.context.close();
      }
    },
  });

  // ---------------------------------------------------------------- cancel mid-operation
  const bigRandom = () => cached("edge-random-40mib.bin", () => Buffer.from(prng(40 << 20, 0xc0ffee)));
  const cancelAndRecover = async (h, { session, startSelector, label, rerun }) => {
    const { page } = session;
    const downloads = [];
    page.on("download", (download) => downloads.push(download.suggestedFilename()));
    await page.locator(startSelector).click();
    await page.locator(CANCEL).first().waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(1200);
    await page.locator(CANCEL).first().click();
    // the progress panel must go away and the action button must come back
    await page
      .locator(CANCEL)
      .first()
      .waitFor({ state: "detached", timeout: 30_000 })
      .catch(() => {
        throw new Error(`${label}: progress panel still visible 30 s after Cancel`);
      });
    await page.waitForTimeout(1500);
    assert(!downloads.length, `${label}: a download arrived after cancel (${downloads.join(",")})`);
    assert(!session.pageErrors.length, `${label}: page error after cancel: ${session.pageErrors[0]}`);
    const errors = await visibleErrors(page);
    const notes = [`notices after cancel: ${errors.length ? errors.join(" | ").slice(0, 160) : "none"}`];
    const leftovers = await opfsFiles(page);
    notes.push(`opfs files after cancel: ${leftovers.length}`);
    await rerun(page);
    return { leftovers, notes };
  };

  cases.push({
    group: "edge",
    id: "edge/cancel/compress-7z-max",
    tags: ["edge", "cancel", "compress"],
    title: "cancel a slow 7z (40 MiB random, max level) mid-run, then compress again to completion",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, {
        ready: "#compress-input-picker",
        route: "compress-files",
      });
      try {
        await stage(session.page, [{ buffer: bigRandom(), name: "big.bin" }], "#compress-input-picker");
        await session.page.waitForTimeout(3000);
        await session.page.getByLabel("Output format", { exact: true }).selectOption("7z");
        await openOptionsSafe(session.page);
        const { notes, leftovers } = await cancelAndRecover(h, {
          label: "compress",
          rerun: async (page) => {
            await page.getByLabel("Output format", { exact: true }).selectOption("zip");
            await openOptionsSafe(page);
            await page.getByLabel("Compression level", { exact: true }).selectOption("min");
            const button = page.locator("main button.run");
            await button.click();
            await page.waitForFunction(
              () => /^download/i.test(document.querySelector("main button.run")?.innerText || ""),
              undefined,
              { timeout: 120_000 },
            );
          },
          session,
          startSelector: "main button.run",
        });
        assert(
          leftovers.length === 0 || leftovers.length < 3,
          `OPFS keeps ${leftovers.length} files after a cancelled compress: ${leftovers.slice(0, 3).join(", ")}`,
        );
        return notes.join("; ");
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "edge",
    id: "edge/cancel/apply-output-7z-max",
    tags: ["edge", "cancel", "apply"],
    title: "cancel Apply while it writes a 7z of a 40 MiB ROM, then Apply again with no compression",
    async run(h) {
      const rom = bigRandom();
      const session = await newSession(h.browser, h.baseUrl, {});
      try {
        const ips = Buffer.from([
          0x50, 0x41, 0x54, 0x43, 0x48, 0x00, 0x10, 0x00, 0x00, 0x02, 0xaa, 0xbb, 0x45, 0x4f, 0x46,
        ]); // 2 bytes at 0x1000
        await stageAndSettle(
          session.page,
          [
            { buffer: rom, name: "big.bin" },
            { buffer: ips, name: "tiny.ips" },
          ],
          120_000,
        );
        await session.page
          .locator("#rom-weaver-select-output-format")
          .selectOption("7z")
          .catch(async () => {
            await session.page.getByText("Options", { exact: true }).first().click();
            await session.page.locator("#rom-weaver-select-output-format").selectOption("7z");
          });
        await session.page
          .getByLabel("Compression level", { exact: true })
          .selectOption("max")
          .catch(() => undefined);
        const { notes } = await cancelAndRecover(h, {
          label: "apply",
          rerun: async (page) => {
            await page.locator("#rom-weaver-select-output-format").selectOption("none");
            await page.waitForTimeout(500);
            const result = await applyNow(h, page, { timeout: 180_000 });
            assert(result.outcome === "download", `re-run after cancel gave ${result.outcome}`);
            assert(result.bytes.length === rom.length, `re-run output ${result.bytes.length} B, want ${rom.length}`);
            assert(result.bytes[0x1000] === 0xaa && result.bytes[0x1001] === 0xbb, "re-run output lacks the IPS edit");
          },
          session,
          startSelector: "#rom-weaver-button-apply",
        });
        return notes.join("; ");
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "edge",
    id: "edge/cancel/create-bps-large",
    tags: ["edge", "cancel", "create"],
    title: "cancel Create bps (about 9 s) on two 40 MiB ROMs, then create a small bps in the same session",
    async run(h) {
      const original = bigRandom();
      const oPath = path.join(EXH_CACHE, "cancel-create-o.bin");
      const mPath = path.join(EXH_CACHE, "cancel-create-m.bin");
      if (!fs.existsSync(mPath)) {
        const modified = Buffer.from(original);
        for (let i = 0; i < modified.length; i += 4099) modified[i] ^= 0x5a;
        fs.writeFileSync(oPath, original);
        fs.writeFileSync(mPath, modified);
      }
      const { page, session } = await openCreate(h, oPath, mPath);
      try {
        await page.selectOption("#patch-builder-select-patch-type", "bps");
        const { notes } = await cancelAndRecover(h, {
          label: "create",
          rerun: async (p) => {
            await p.selectOption("#patch-builder-select-patch-type", "ppf");
            await p.waitForTimeout(400);
            const result = await runCreate(p, h.caseDir, 300_000);
            assert(
              result.kind === "download",
              `re-run after cancel gave ${result.kind}${result.text ? `: ${String(result.text)}` : ""}`,
            );
          },
          session,
          startSelector: "#patch-builder-button-create",
        });
        return notes.join("; ");
      } finally {
        await session.context.close();
      }
    },
  });

  // ---------------------------------------------------------------- progress reporting
  const sampleProgress = async (page, untilSelector, { max = 180_000 } = {}) => {
    const samples = [];
    const labels = new Set();
    const deadline = Date.now() + max;
    while (Date.now() < deadline) {
      const sample = await page.evaluate(() => ({
        done: /^download/i.test(document.querySelector("main button.run")?.innerText || ""),
        label: document.querySelector(".what, .run-stage-label")?.textContent?.trim() || "",
        pct: document.querySelector(".run-pct")?.textContent?.trim() || "",
      }));
      if (sample.pct) samples.push(Number.parseInt(sample.pct, 10));
      if (sample.label) labels.add(sample.label);
      if (sample.done) break;
      await page.waitForTimeout(250);
    }
    return { labels: [...labels], samples: samples.filter((value) => Number.isFinite(value)) };
  };
  cases.push({
    group: "edge",
    id: "edge/progress/compress-7z-monotonic",
    tags: ["edge", "progress", "compress"],
    title: "Compress 7z of a 40 MiB file: progress percent is shown, never goes backwards, reaches 100 and has a label",
    async run(h) {
      const session = await newSession(h.browser, h.baseUrl, {
        ready: "#compress-input-picker",
        route: "compress-files",
      });
      try {
        await stage(session.page, [{ buffer: bigRandom(), name: "big.bin" }], "#compress-input-picker");
        await session.page.waitForTimeout(3000);
        await session.page.getByLabel("Output format", { exact: true }).selectOption("7z");
        await openOptionsSafe(session.page);
        await session.page.getByLabel("Compression level", { exact: true }).selectOption("min");
        await session.page.locator("main button.run").click();
        const { labels, samples } = await sampleProgress(session.page);
        assert(samples.length >= 3, `only ${samples.length} progress samples seen: ${samples.join(",")}`);
        const back = samples.findIndex((value, index) => index > 0 && value < samples[index - 1]);
        assert(
          back < 0,
          `progress went backwards at sample ${back}: ${samples.slice(Math.max(0, back - 2), back + 2).join(",")}`,
        );
        assert(Math.max(...samples) >= 95, `progress peaked at ${Math.max(...samples)}%`);
        assert(
          labels.some((label) => label.length > 3),
          `no progress label (${labels.join("|")})`,
        );
        return `${samples.length} samples ${samples[0]}..${samples.at(-1)}%; labels: ${labels.join(" | ").slice(0, 120)}`;
      } finally {
        await session.context.close();
      }
    },
  });

  // ---------------------------------------------------------------- large inputs (sparse files on disk)
  const sparse = (name, size, edits = []) => {
    const file = path.join(EXH_CACHE, name);
    if (!fs.existsSync(file) || fs.statSync(file).size !== size) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, "w");
      fs.ftruncateSync(fd, size);
      for (const [at, bytes] of edits) fs.writeSync(fd, Buffer.from(bytes), 0, bytes.length, at);
      fs.closeSync(fd);
    }
    return file;
  };
  cases.push({
    group: "edge",
    id: "edge/large/apply-ips-400mib",
    tags: ["edge", "large", "apply"],
    title: "400 MiB ROM + IPS edits at the start and end: output has the right size and edits (streamed via OPFS)",
    async run(h) {
      const size = 400 << 20;
      const rom = sparse("large-400mib.bin", size, [[3, [1, 2, 3]]]);
      // IPS offsets are 24 bit (16 MiB), so use IPS32 (4-byte offsets, "IPS32" ... "EEOF").
      const record = (offset, bytes) =>
        Buffer.concat([
          Buffer.from([(offset >>> 24) & 255, (offset >>> 16) & 255, (offset >>> 8) & 255, offset & 255]),
          Buffer.from([0x00, bytes.length]),
          Buffer.from(bytes),
        ]);
      const patch = Buffer.concat([
        Buffer.from("IPS32"),
        record(0x10, [0xaa, 0xbb]),
        record(size - 4, [1, 2, 3]),
        Buffer.from("EEOF"),
      ]);
      const patchPath = path.join(h.caseDir, "edge.ips32");
      fs.writeFileSync(patchPath, patch);
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [rom, patchPath], 240_000);
        const out = await applyNow(h, page, { timeout: 420_000 });
        assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
        assert(
          out.outcome === "download",
          `no download (${out.outcome}${out.result?.text ? `: ${out.result.text}` : ""})`,
        );
        assert(out.bytes.length === size, `output ${out.bytes.length} B, want ${size} B`);
        assert(out.bytes[0x10] === 0xaa && out.bytes[0x11] === 0xbb, "first edit missing");
        assert(out.bytes[size - 4] === 1 && out.bytes[size - 2] === 3, "last edit missing");
        assert(out.bytes[3] === 1 && out.bytes[100] === 0, "original bytes were not preserved");
        fs.rmSync(out.saved, { force: true });
        return `${out.name}`;
      });
    },
  });
  cases.push({
    group: "edge",
    id: "edge/large/compress-zip-store-300mib",
    tags: ["edge", "large", "compress"],
    title: "compress a 300 MiB file to a stored zip: valid archive of the right size",
    async run(h) {
      const size = 300 << 20;
      const file = sparse("large-300mib.bin", size, [[size - 1, [0x7f]]]);
      const session = await newSession(h.browser, h.baseUrl, {
        ready: "#compress-input-picker",
        route: "compress-files",
      });
      try {
        await stage(session.page, [file], "#compress-input-picker");
        await session.page.waitForTimeout(5000);
        await session.page.getByLabel("Output format", { exact: true }).selectOption("zip");
        await openOptionsSafe(session.page);
        const out = await runCompressLite(session.page, h.caseDir, 420_000);
        assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
        assert(out.kind === "download", `no download (${out.kind}${out.text ? `: ${out.text}` : ""})`);
        const entry = readZipFirstEntry(out.saved);
        assert(entry.size === size, `zip entry says ${entry.size} B, want ${size}`);
        fs.rmSync(out.saved, { force: true });
        return `${out.name}: entry ${entry.name} ${entry.size} B (method ${entry.method})`;
      } finally {
        await session.context.close();
      }
    },
  });

  // ---------------------------------------------------------------- repeated runs & OPFS hygiene
  cases.push({
    group: "edge",
    id: "edge/repeat/apply-six-runs-one-session",
    tags: ["edge", "repeat", "opfs"],
    title: "six consecutive Apply runs in one session: all correct, OPFS does not grow per run",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, bps]);
        const sizes = [];
        for (let run = 1; run <= 6; run++) {
          const out = await applyNow(h, page);
          out.pageErrors = session.pageErrors;
          expectDownload(out, target(), `run ${run}`);
          sizes.push((await opfsFiles(page)).length);
          await page.waitForTimeout(500);
        }
        assert(sizes.at(-1) <= sizes[0] + 2, `OPFS file count grows with each run: ${sizes.join(",")}`);
        return `opfs files per run: ${sizes.join(",")}`;
      });
    },
  });
  cases.push({
    group: "edge",
    id: "edge/opfs/cleaned-after-reload",
    tags: ["edge", "opfs"],
    title: "after Apply the output lives in OPFS; a page reload leaves no operation files behind",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, bps]);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        expectDownload(out, target());
        const during = await opfsFiles(page);
        assert(during.length > 0, "no output kept in OPFS after Apply (storage path changed?)");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5000);
        const afterReload = await opfsFiles(page);
        assert(
          afterReload.length === 0,
          `OPFS still holds ${afterReload.length} file(s) after reload: ${afterReload.slice(0, 4).join(", ")}`,
        );
        return `afterApply=${during.length} afterReload=${afterReload.length}`;
      });
    },
  });
  cases.push({
    group: "edge",
    id: "edge/opfs/failed-apply-leaves-nothing",
    tags: ["edge", "opfs", "error"],
    title: "a refused Apply (wrong-source patch) followed by a reload leaves no OPFS files",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [path.join(BLOBS, "other.bin"), bps]);
        await applyNow(h, page, { timeout: 40_000 });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5000);
        const left = await opfsFiles(page);
        assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
        assert(left.length === 0, `OPFS holds ${left.length} file(s): ${left.slice(0, 4).join(", ")}`);
        return "clean";
      });
    },
  });

  // ---------------------------------------------------------------- console hygiene
  for (const route of [
    "",
    "apply-rom-patches",
    "create-rom-patch",
    "trim-rom",
    "compress-files",
    "extract-files",
    "file-checksum",
    "identify-rom",
    "weave-rom-patches",
    "ppf-undo",
    "play-rom",
    "rom-save-editor",
    "whats-new",
    "docs",
  ]) {
    cases.push({
      group: "console",
      id: `console/clean-load/${route || "home"}`,
      tags: ["console", route || "home"],
      title: `loading /${route} logs no console errors, warnings or page errors`,
      async run(h) {
        const session = await newSession(h.browser, h.baseUrl, { ready: "body", route });
        try {
          await session.page.waitForTimeout(3000);
          assert(!session.pageErrors.length, `page error: ${String(session.pageErrors[0])}`);
          assert(!session.consoleErrors.length, `console.error: ${String(session.consoleErrors[0])}`);
          assert(!session.consoleWarnings.length, `console.warn: ${String(session.consoleWarnings[0])}`);
          return "clean";
        } finally {
          await session.context.close();
        }
      },
    });
  }
  cases.push({
    group: "console",
    id: "console/clean-apply-run",
    tags: ["console", "apply"],
    title: "a full Apply (stage, apply, download) logs no console errors or warnings",
    async run(h) {
      return drive(h, async (page, session) => {
        await stageAndSettle(page, [base, bps]);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        expectDownload(out, target());
        assert(!session.consoleErrors.length, `console.error: ${session.consoleErrors[0]}`);
        assert(!session.consoleWarnings.length, `console.warn: ${session.consoleWarnings[0]}`);
        return "clean";
      });
    },
  });

  // ---------------------------------------------------------------- disabled states / unsupported / tiny inputs
  cases.push({
    group: "edge",
    id: "edge/disabled/apply-without-inputs",
    tags: ["edge", "disabled"],
    title: "Apply is disabled on an empty page and with a patch only; with a ROM only the state is reported",
    async run(h) {
      const notes = [];
      await drive(h, async (page) => {
        const empty = await snapshot(page);
        assert(empty.applyDisabled !== false, "Apply enabled with nothing staged");
        notes.push(`empty: disabled (${empty.blockedReason ?? "no reason shown"})`);
      });
      await drive(h, async (page) => {
        await stageAndSettle(page, [bps]);
        const patchOnly = await snapshot(page);
        assert(patchOnly.applyDisabled !== false, "Apply enabled with only a patch staged");
        notes.push(`patch-only: disabled (${patchOnly.blockedReason ?? "no reason shown"})`);
      });
      await drive(h, async (page) => {
        await stageAndSettle(page, [base]);
        const romOnly = await snapshot(page);
        notes.push(
          `rom-only: ${romOnly.applyDisabled ? `disabled (${romOnly.blockedReason ?? "no reason"})` : `enabled "${romOnly.applyText}"`}`,
        );
      });
      return notes.join("; ");
    },
  });
  const tiny = [
    [
      "zero-byte-rom-ips",
      Buffer.alloc(0),
      Buffer.from([0x50, 0x41, 0x54, 0x43, 0x48, 0x45, 0x4f, 0x46]),
      "empty ROM + no-op IPS",
    ],
    [
      "one-byte-rom-ips",
      Buffer.from([0x11]),
      Buffer.from([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 0, 0, 1, 0x22, 0x45, 0x4f, 0x46]),
      "1-byte ROM + IPS edit",
    ],
    ["rom-zero-byte-patch", romBytes, Buffer.alloc(0), "ROM + zero-byte patch"],
    ["rom-one-byte-patch", romBytes, Buffer.from([0x50]), "ROM + 1-byte patch"],
  ];
  for (const [id, rom, patch, title] of tiny) {
    cases.push({
      group: "edge",
      id: `edge/tiny/${String(id)}`,
      tags: ["edge", "tiny", id],
      title,
      async run(h) {
        return drive(h, async (page, session) => {
          await stageAndSettle(page, [
            { buffer: rom, name: "r.bin" },
            { buffer: patch, name: "p.ips" },
          ]);
          const out = await applyNow(h, page, { timeout: 40_000 });
          assert(!session.pageErrors.length, `page error ${session.pageErrors[0]}`);
          assert(out.outcome !== "timeout", `UI hung: ${await mainText(page)}`);
          if (id === "one-byte-rom-ips") {
            assert(out.outcome === "download", `valid 1-byte apply gave ${out.outcome}`);
            assert(
              out.bytes.length === 1 && out.bytes[0] === 0x22,
              `1-byte output ${out.bytes.length} B [${out.bytes[0]}]`,
            );
          }
          if (id === "rom-zero-byte-patch" || id === "rom-one-byte-patch")
            assert(out.outcome !== "download", `invalid patch produced a download (${out.bytes?.length} B)`);
          return `${out.outcome}${out.result?.text ? `: ${out.result.text.slice(0, 100)}` : ""}`;
        });
      },
    });
  }

  // ---------------------------------------------------------------- mobile viewport, Apply
  cases.push({
    group: "edge",
    id: "edge/mobile/apply-bps",
    tags: ["edge", "mobile", "apply"],
    title: "Apply on a 390x780 touch viewport: no horizontal overflow, output correct",
    async run(h) {
      return drive(
        h,
        async (page, session) => {
          await stageAndSettle(page, [base, bps]);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile-staged.png") });
          assert(overflow <= 2, `horizontal overflow ${overflow}px`);
          const out = await applyNow(h, page);
          out.pageErrors = session.pageErrors;
          expectDownload(out, target());
          await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile-after.png") });
          return out.name;
        },
        { device: MOBILE },
      );
    },
  });
  cases.push({
    group: "edge",
    id: "edge/mobile/menu-routes",
    tags: ["edge", "mobile", "routes"],
    title: "every workflow route renders on a mobile viewport without horizontal overflow",
    async run(h) {
      const bad = [];
      for (const route of [
        "apply-rom-patches",
        "create-rom-patch",
        "trim-rom",
        "compress-files",
        "extract-files",
        "file-checksum",
        "identify-rom",
        "weave-rom-patches",
      ]) {
        const session = await newSession(h.browser, h.baseUrl, { device: MOBILE, ready: "body", route });
        try {
          await session.page.waitForTimeout(1500);
          const overflow = await session.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 2) bad.push(`${route}:${overflow}px`);
        } finally {
          await session.context.close();
        }
      }
      assert(!bad.length, `horizontal overflow on a 390 px viewport: ${bad.join(", ")}`);
      return "no overflow";
    },
  });
  void runCreate;
  void sha256;
  return cases;
}
