// Disc / console image inputs for the ROM slot: CSO, CISO, WBFS (+ split), TGC, GCZ, PBP, CHD, RVZ, NFS, XISO.
// The webapp extracts them, patches the payload and offers output formats. Oracle: the downloaded
// bytes (output format "none") equal the independently patched payload.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { cliExtract } from "./lib/cli.mjs";
import { sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import { applyNow, choose, drive, fail, Skip, stageAndSettle } from "./lib/scenario.mjs";
import { snapshot, stage, waitSettled } from "./lib/ui.mjs";
import { patchContainerFixtures, rawBpsFixture, xisoFixture } from "../fixtures/synthetic-patch-containers.mjs";
import { syntheticNfs } from "../fixtures/synthetic-nfs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_GENERATED = path.resolve(HERE, "../fixtures/browser-generated");
const read = (file) => fs.readFileSync(file);

const adler32 = (bytes) => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const gczFrom = (iso) => {
  const blockSize = 0x8000;
  const blocks = [];
  for (let offset = 0; offset < iso.length; offset += blockSize)
    blocks.push(new Uint8Array(zlib.deflateSync(iso.subarray(offset, offset + blockSize))));
  const dataSize = blocks.reduce((size, block) => size + block.length, 0);
  const headerSize = 32 + blocks.length * 12;
  const gcz = new Uint8Array(headerSize + dataSize);
  const view = new DataView(gcz.buffer);
  gcz.set([0x01, 0xc0, 0x0b, 0xb1]);
  view.setBigUint64(8, BigInt(dataSize), true);
  view.setBigUint64(16, BigInt(iso.length), true);
  view.setUint32(24, blockSize, true);
  view.setUint32(28, blocks.length, true);
  let offset = 0;
  for (const [index, block] of blocks.entries()) {
    view.setBigUint64(32 + index * 8, BigInt(offset), true);
    view.setUint32(32 + blocks.length * 8 + index * 4, adler32(block), true);
    gcz.set(block, headerSize + offset);
    offset += block.length;
  }
  return gcz;
};

const gamecubeIso = (size) => {
  const iso = new Uint8Array(size);
  iso.set(new TextEncoder().encode("RWTEST"));
  iso.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  iso.set(new TextEncoder().encode("rom-weaver-test"), 0x20);
  for (let index = 0x440; index < iso.length; index++) iso[index] = (index - 0x440) % 251;
  return iso;
};

const syntheticNfsPlain = () => {
  const plain = Uint8Array.from({ length: 0x8000 * 4 }, (_, index) => (index * 7 + 19) & 0xff);
  plain.fill(0, 0, 0x440);
  plain.set(new TextEncoder().encode("GAUE01"));
  plain.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  plain.set(new TextEncoder().encode("Synthetic NFS browser regression"), 0x20);
  return plain;
};

/** Check a disc apply output: raw bytes directly, containers via native extraction (payload must appear). */
const verifyDiscOutput = (out, target) => {
  const raw = Buffer.compare(Buffer.from(out.bytes), Buffer.from(target)) === 0;
  if (raw) return "raw payload";
  const extracted = cliExtract(out.bytes, out.name);
  if (!extracted) return `container ${out.name} (no native CLI to open it)`;
  if (extracted.error) fail(out, `native CLI cannot open the ${out.name} the webapp wrote: ${extracted.error}`);
  const targetSha = sha256(target);
  if (!extracted.files.some((file) => sha256(file.bytes) === targetSha))
    fail(
      out,
      `${out.name} does not contain the patched payload; files: ${extracted.files.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}`,
    );
  return `container ${out.name} holds the patched payload`;
};

const discCase = ({ id, tags, title, buildFiles, everyFormat }) => ({
  group: "disc-input",
  id: `disc/${id}${everyFormat ? "/each-output-format" : ""}`,
  tags: ["disc", ...tags, ...(everyFormat ? ["output"] : [])],
  title,
  async run(h) {
    const built = await buildFiles(h);
    return drive(h, async (page, session) => {
      if (built.pick) {
        await stage(page, built.files);
        if (!(await choose(page, built.pick)))
          fail({ outcome: "no-picker", staged: await snapshot(page) }, "expected a picker");
        await waitSettled(page, 120_000).catch(() => undefined);
        await page.waitForTimeout(800);
      } else await stageAndSettle(page, built.files, 120_000);
      const staged = await snapshot(page);
      await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "staged.png") });
      const formats = staged.formatOptions.map((option) => option.value);
      const notes = [`offered=${formats.join(",")} default=${staged.formatValue}`];
      const runs = everyFormat ? formats : [staged.formatValue];
      for (const format of runs) {
        if (everyFormat) {
          await page
            .getByText("Options", { exact: true })
            .last()
            .click()
            .catch(() => undefined);
          await page.selectOption("#rom-weaver-select-output-format", format);
          await page.waitForTimeout(600);
        }
        const out = await applyNow(h, page, { timeout: 180_000 });
        out.pageErrors = session.pageErrors;
        out.after = await snapshot(page);
        await page.screenshot({
          fullPage: true,
          path: path.join(h.caseDir, `after-${format}.png`),
        });
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (built.expectRefusal) {
          if (out.outcome === "download") fail(out, "expected refusal");
          return `refused (${out.outcome})`;
        }
        if (out.outcome !== "download") fail(out, `no download for output format ${format}`);
        notes.push(`${format}: ${verifyDiscOutput(out, built.target)}`);
      }
      return notes.join("; ");
    });
  },
});

const EVERY_FORMAT_FOR = new Set(["cso", "wbfs", "pbp", "chd-cd", "rvz", "gcz"]);

export function discCases() {
  const cases = [];
  const add = (definition) => {
    cases.push(discCase(definition));
    if (EVERY_FORMAT_FOR.has(definition.id)) cases.push(discCase({ ...definition, everyFormat: true }));
  };
  const offset = 0x900;
  for (const fixture of patchContainerFixtures()) {
    add({
      buildFiles: () => {
        const { patch, target } = rawBpsFixture(fixture.payload, offset);
        return {
          files: [
            { buffer: fixture.container, name: `disc.${fixture.extension}` },
            { buffer: patch, name: "flip.bps" },
          ],
          target,
        };
      },
      id: fixture.extension,
      tags: [fixture.extension],
      title: `synthetic ${fixture.extension} as the ROM`,
    });
  }
  add({
    buildFiles: () => {
      const iso = gamecubeIso(0x30000); // whole 0x8000 blocks: the GCZ reader rejects a short final block
      const { patch, target } = rawBpsFixture(iso, offset);
      return {
        files: [
          { buffer: gczFrom(iso), name: "game.gcz" },
          { buffer: patch, name: "flip.bps" },
        ],
        target,
      };
    },
    id: "gcz",
    tags: ["gcz"],
    title: "synthetic GCZ (zlib blocks)",
  });
  add({
    buildFiles: () => {
      const { container, payload } = patchContainerFixtures().find((f) => f.extension === "wbfs");
      const chunk = Math.ceil(container.length / 3);
      const parts = [0, 1, 2].map((index) => ({
        buffer: container.subarray(index * chunk, (index + 1) * chunk),
        name: index === 0 ? "Disc.wbfs" : `Disc.wbf${index}`,
      }));
      const { patch, target } = rawBpsFixture(payload, offset);
      void target;
      return {
        expectRefusal: true,
        files: [...parts, { buffer: patch, name: "flip.bps" }],
        pick: ["Disc.wbfs"],
      };
    },
    id: "wbfs-split-3",
    tags: ["wbfs", "split", "error-ux"],
    title:
      "WBFS split across Disc.wbfs/.wbf1/.wbf2 uploaded together: docs/reference/formats.md says only Extract reads split sets, so Apply must refuse with an error (never a wrong download)",
  });
  add({
    buildFiles: () => {
      const { container, payload } = patchContainerFixtures().find((f) => f.extension === "wbfs");
      const chunk = Math.ceil(container.length / 3);
      const parts = [0, 2].map((index) => ({
        buffer: container.subarray(index * chunk, (index + 1) * chunk),
        name: index === 0 ? "Disc.wbfs" : `Disc.wbf${index}`,
      }));
      const { patch } = rawBpsFixture(payload, offset);
      return { expectRefusal: true, files: [...parts, { buffer: patch, name: "flip.bps" }] };
    },
    id: "wbfs-split-missing-part",
    tags: ["wbfs", "split", "error-ux"],
    title: "WBFS split set with a missing middle part must be refused",
  });
  add({
    buildFiles: () => {
      // quality-reason: NFS expands to a 1.4 GB GameCube image, too large for a unit-sized patch; covered by tests/e2e/nfs-apply.test.mjs.
      throw new Skip(
        "NFS expands to a 1,459,978,240-byte GameCube image, so a unit-sized patch cannot target it; covered by tests/e2e/nfs-apply.test.mjs (run once by this effort, see report)",
      );
    },
    id: "nfs+key",
    tags: ["nfs"],
    title: "synthetic NFS plus its key file",
  });
  add({
    buildFiles: async () => {
      const { source } = await syntheticNfs();
      const { patch } = rawBpsFixture(syntheticNfsPlain(), offset);
      return {
        expectRefusal: true,
        files: [
          { buffer: new Uint8Array(await source.arrayBuffer()), name: "hif_000000.nfs" },
          { buffer: patch, name: "flip.bps" },
        ],
      };
    },
    id: "nfs-without-key",
    tags: ["nfs", "error-ux"],
    title: "NFS without its key file must be refused or asked for",
  });
  add({
    buildFiles: () => {
      const xiso = xisoFixture();
      const { patch, target } = rawBpsFixture(xiso, 34 * 2048 + 1);
      return {
        files: [
          { buffer: xiso, name: "canonical.xiso" },
          { buffer: patch, name: "flip.bps" },
        ],
        target,
      };
    },
    id: "xiso",
    tags: ["xiso"],
    title: "synthetic XISO as the ROM",
  });

  // CHD / RVZ: reuse the repo's browser-generated fixtures; payload bytes come from native extraction.
  for (const [file, label, payloadName] of [
    ["game-cd.chd", "chd-cd", "game-cd.bin"],
    ["raw32.chd", "chd-raw", "raw32.bin"],
    ["game.rvz", "rvz", "game.iso"],
  ]) {
    add({
      buildFiles: () => {
        const extracted = cliExtract(read(path.join(BROWSER_GENERATED, file)), file);
        if (!extracted) throw new Skip("needs the native CLI to learn the extracted payload bytes");
        if (extracted.error) throw new Error(`native extract of ${file} failed: ${extracted.error}`);
        const found = extracted.files.find(
          (f) => f.name.endsWith(payloadName.split(".").pop()) && !f.name.endsWith(".cue"),
        );
        // Copy into a Uint8Array: Buffer#slice aliases memory and rawBpsFixture mutates its copy.
        const payload = found ? Uint8Array.from(found.bytes) : new Uint8Array(0);
        if (payload.length <= offset)
          throw new Error(
            `native extract of ${file} gave ${extracted.files.map((f) => f.name).join(",") || "nothing"}`,
          );
        const { patch, target } = rawBpsFixture(payload, offset);
        return {
          files: [path.join(BROWSER_GENERATED, file), { buffer: patch, name: "flip.bps" }],
          target,
        };
      },
      id: label,
      tags: [label.split("-")[0]],
      title: `repo fixture ${file}`,
    });
  }
  return cases;
}
