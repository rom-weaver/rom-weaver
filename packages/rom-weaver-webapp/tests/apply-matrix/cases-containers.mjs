// Input containers: ROM and patch uploaded inside zip/7z/rar/tar/gz/xz/bz2/zst/lz4, nested, multi-member
// (selection UI), unicode member names, and unsupported/encrypted/corrupt containers (error UX).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOBS, CACHE } from "../fixtures/apply-matrix/generate.mjs";
import { cliApply } from "./lib/cli.mjs";
import { applyNow, assert, choose, drive, expectDownload, fail, Skip, stageAndSettle } from "./lib/scenario.mjs";
import { snapshot, stage, waitSettled } from "./lib/ui.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBAPP_FIXTURES = path.resolve(HERE, "../fixtures");
const read = (file) => fs.readFileSync(file);
const base = path.join(BLOBS, "base.bin");
const bps = path.join(BLOBS, "bps-same.bps");
const target = () => read(path.join(BLOBS, "target-same.bin"));

const ROM_CONTAINERS = [
  "rom.zip",
  "rom-stored.zip",
  "rom.tar",
  "base.bin.gz",
  "base.bin.xz",
  "base.bin.bz2",
  "base.bin.zst",
  "base.bin.lz4",
  "rom.gz",
  "rom-nofname.gz",
  "rom.xz",
  "rom.bz2",
  "rom.zst",
  "rom.lz4",
  "rom.tar.gz",
  "rom.tar.xz",
  "rom.tar.bz2",
  "rom.7z",
  "nested.zip",
  "unicode-ゲーム-é.zip",
];
const PATCH_CONTAINERS = [
  "patch.zip",
  "patch-stored.zip",
  "patch.tar",
  "bps-same.bps.gz",
  "bps-same.bps.xz",
  "bps-same.bps.bz2",
  "bps-same.bps.zst",
  "bps-same.bps.lz4",
  "patch.gz",
  "patch.xz",
  "patch.bz2",
  "patch.zst",
  "patch.lz4",
  "patch.tar.gz",
  "patch.tar.xz",
  "patch.tar.bz2",
  "patch.7z",
];

const tagOf = (name) =>
  name
    .replace(/^(rom|patch|base\.bin|bps-same\.bps)-?/, "")
    .replace(/^\./, "")
    .split("-")[0] || name;
const ipsApply = (source, record) => {
  const out = Uint8Array.from(source);
  out[record.offset] = record.byte;
  return out;
};

/** Run one containers scenario and verify the output (or a refusal). */
const inContainer = ({ id, tags, title, files, expected, expectRefusal, configure, shot = "c" }) => ({
  group: "container-input",
  id,
  tags: ["container", ...tags],
  title,
  async run(h) {
    return drive(h, async (page, session) => {
      const needed = files.filter((file) => typeof file === "string" && !fs.existsSync(file));
      if (needed.length)
        throw new Skip(`fixture missing: ${path.basename(needed[0])} (see tests/fixtures/apply-matrix/manifest.json)`);
      await stageAndSettle(page, files);
      if (configure) await configure(page);
      const out = await applyNow(h, page);
      out.pageErrors = session.pageErrors;
      await page.screenshot({ fullPage: true, path: path.join(h.caseDir, `${shot}.png`) });
      out.after = await snapshot(page);
      if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
      if (expectRefusal) {
        if (out.outcome === "download") fail(out, "expected a refusal but got a download");
        if (out.outcome === "timeout") fail(out, "hang: neither an error nor a block was shown");
        const visible = [
          ...out.after.notices.map((n) => n.text),
          out.after.blockedReason,
          ...out.after.cards.map((c) => c.text),
        ]
          .filter(Boolean)
          .join(" ");
        return `refused (${out.outcome}): ${visible.slice(0, 160)}`;
      }
      expectDownload(out, expected);
      return `${out.name} ${out.bytes.length} B`;
    });
  },
});

export function containerCases({ manifest }) {
  const cases = [];
  const have = (name) => manifest.entries.some((entry) => entry.name === name && !entry.unavailable);
  const cacheFile = (name) => path.join(CACHE, name);
  const missing = (name) => manifest.entries.find((entry) => entry.name === name)?.unavailable;

  for (const name of ROM_CONTAINERS) {
    cases.push({
      ...inContainer({
        expected: target(),
        files: [cacheFile(name), bps],
        id: `rom-in/${name}`,
        tags: ["rom", tagOf(name)],
        title: `ROM inside ${name}`,
      }),
      ...(have(name) ? {} : { skip: `fixture ${name} unavailable: ${missing(name)}` }),
    });
  }
  for (const name of PATCH_CONTAINERS) {
    cases.push({
      ...inContainer({
        expected: target(),
        files: [base, cacheFile(name)],
        id: `patch-in/${name}`,
        tags: ["patch", tagOf(name)],
        title: `patch inside ${name}`,
      }),
      ...(have(name) ? {} : { skip: `fixture ${name} unavailable: ${missing(name)}` }),
    });
  }
  cases.push(
    inContainer({
      expected: target(),
      files: [cacheFile("patch-and-rom.zip")],
      id: "both-in/patch-and-rom.zip",
      tags: ["rom", "patch", "zip"],
      title: "one zip with ROM and patch dropped alone",
    }),
  );
  cases.push(
    inContainer({
      expected: target(),
      files: [cacheFile("rom.zip"), cacheFile("patch.zip")],
      id: "both-in/rom.zip+patch.zip",
      tags: ["rom", "patch", "zip"],
      title: "ROM zip plus patch zip",
    }),
  );

  // Selection UI: the app opens a picker for multi-member archives. Oracle: each choice patches that member.
  const selectCase = ({ id, tags, title, files, pick, expected, afterPick }) => ({
    group: "container-select",
    id: `select/${id}`,
    tags: ["container", "select", ...tags],
    title,
    async run(h) {
      return drive(h, async (page, session) => {
        for (const file of files)
          if (typeof file === "string" && !fs.existsSync(file))
            throw new Skip(`fixture missing: ${path.basename(file)}`);
        await stage(page, files);
        const shown = await choose(page, pick);
        if (!shown)
          fail(
            { outcome: "no-picker", staged: await snapshot(page) },
            "no candidate picker appeared for a multi-member archive",
          );
        await page.waitForTimeout(1500);
        await waitSettled(page, 30_000).catch(() => undefined);
        await page.waitForTimeout(800);
        if (afterPick) await afterPick(page);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        out.after = await snapshot(page);
        await page.screenshot({ fullPage: true, path: path.join(h.caseDir, "after-pick.png") });
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        expectDownload(out, expected);
        return `${out.name}`;
      });
    },
  });
  cases.push(
    selectCase({
      expected: target(),
      files: [cacheFile("multi-rom.zip"), bps],
      id: "multi-rom.zip/base.bin",
      pick: ["base.bin"],
      tags: ["multi-rom", "zip"],
      title: "multi-ROM zip: choose base.bin, patch applies",
    }),
  );
  cases.push(
    selectCase({
      expected: read(path.join(BLOBS, "target-same.bin")),
      files: [cacheFile("multi-rom.zip"), cacheFile("patch.zip")],
      id: "multi-rom.zip/base.bin+patch.zip",
      pick: ["base.bin"],
      tags: ["multi-rom", "zip"],
      title: "multi-ROM zip + patch zip: choose base.bin",
    }),
  );
  cases.push({
    group: "container-select",
    id: "select/multi-rom.zip/bonus.sfc-not-matching",
    tags: ["container", "select", "multi-rom", "zip", "wrong-rom"],
    title:
      "multi-ROM zip: choose bonus.sfc (the wrong ROM for the bps): Apply must be blocked or fail loudly, never a wrong download",
    async run(h) {
      return drive(h, async (page, session) => {
        await stage(page, [cacheFile("multi-rom.zip"), bps]);
        if (!(await choose(page, ["bonus.sfc"])))
          fail({ outcome: "no-picker", staged: await snapshot(page) }, "no picker");
        await page.waitForTimeout(2500);
        const out = await applyNow(h, page);
        out.pageErrors = session.pageErrors;
        if (out.pageErrors.length) fail(out, `page error ${out.pageErrors[0]}`);
        if (out.outcome === "download") fail(out, `produced ${out.bytes.length} B from the wrong ROM`);
        return `refused (${out.outcome})`;
      });
    },
  });
  cases.push(
    selectCase({
      expected: target(),
      files: [base, cacheFile("multi-patch.zip")],
      id: "multi-patch.zip/pick-a-bps",
      pick: ["a-bps-same.bps"],
      tags: ["multi-patch", "zip"],
      title: "multi-patch zip: pick only a-bps-same.bps",
    }),
  );
  cases.push(
    selectCase({
      expected: target(),
      files: [base, cacheFile("multi-patch.zip")],
      id: "multi-patch.zip/pick-b-ips",
      pick: ["b-ips-same.ips"],
      tags: ["multi-patch", "zip"],
      title: "multi-patch zip: pick only b-ips-same.ips",
    }),
  );

  // The repo's own small archives (13-byte ROM, tiny IPS): zip / 7z / rar.
  const archives = path.join(WEBAPP_FIXTURES, "archives");
  const sources = path.join(WEBAPP_FIXTURES, "archive_sources");
  const game = read(path.join(sources, "game.bin"));
  const patched = ipsApply(game, { byte: 0x58, offset: 1 });
  const bonusRom = read(path.join(sources, "multi-rom", "bonus.sfc"));
  const patchedAlt = ipsApply(game, { byte: 0x59, offset: 1 });
  for (const ext of ["zip", "7z", "rar"]) {
    cases.push(
      inContainer({
        expected: patched,
        files: [path.join(archives, `one-rom.${ext}`), path.join(sources, "change.ips")],
        id: `repo-fixture/one-rom.${ext}`,
        tags: ["rom", ext, "repo-fixture"],
        title: `existing one-rom.${ext} + change.ips`,
      }),
    );
    cases.push(
      inContainer({
        expected: patched,
        files: [path.join(sources, "game.bin"), path.join(archives, `one-patch.${ext}`)],
        id: `repo-fixture/one-patch.${ext}`,
        tags: ["patch", ext, "repo-fixture"],
        title: `game.bin + existing one-patch.${ext}`,
      }),
    );
    cases.push(
      selectCase({
        expected: patched,
        files: [path.join(archives, `multi-rom.${ext}`), path.join(sources, "change.ips")],
        id: `repo-multi-rom.${ext}/game.bin`,
        pick: ["game.bin"],
        tags: [ext, "repo-fixture", "multi-rom"],
        title: `existing multi-rom.${ext}: choose game.bin`,
      }),
    );
    cases.push(
      selectCase({
        expected: ipsApply(bonusRom, { byte: 0x58, offset: 1 }),
        files: [path.join(archives, `multi-rom.${ext}`), path.join(sources, "change.ips")],
        id: `repo-multi-rom.${ext}/bonus.sfc`,
        pick: ["bonus.sfc"],
        tags: [ext, "repo-fixture", "multi-rom"],
        title: `existing multi-rom.${ext}: choose bonus.sfc`,
      }),
    );
    cases.push(
      selectCase({
        expected: patchedAlt,
        files: [path.join(sources, "game.bin"), path.join(archives, `multi-patch.${ext}`)],
        id: `repo-multi-patch.${ext}/alternate`,
        pick: ["alternate.ips"],
        tags: [ext, "repo-fixture", "multi-patch"],
        title: `game.bin + existing multi-patch.${ext}: pick alternate.ips`,
      }),
    );
  }

  // Unsupported / hostile / empty containers: must refuse cleanly.
  const refuse = (id, title, files, tags) =>
    inContainer({ expectRefusal: true, files, id, tags: [...tags, "error-ux"], title });
  cases.push({
    ...refuse(
      "refuse/encrypted.zip",
      "password-protected zip as ROM",
      [cacheFile("encrypted.zip"), bps],
      ["encrypted", "zip"],
    ),
    ...(have("encrypted.zip") ? {} : { skip: missing("encrypted.zip") }),
  });
  cases.push(
    refuse("refuse/truncated.zip", "zip cut short as ROM", [cacheFile("truncated.zip"), bps], ["corrupt", "zip"]),
  );
  cases.push(
    refuse("refuse/garbage.zip", "random bytes named .zip as ROM", [cacheFile("garbage.zip"), bps], ["corrupt", "zip"]),
  );
  cases.push(
    refuse(
      "refuse/readme-only.zip",
      "zip with no ROM inside",
      [path.join(archives, "readme-only.zip"), bps],
      ["no-rom", "zip"],
    ),
  );
  cases.push(refuse("refuse/empty-rom", "zero-byte ROM file", [cacheFile("empty-rom.bin"), bps], ["empty"]));
  cases.push(refuse("refuse/rom-is-patch-only", "only a patch, no ROM", [bps], ["no-rom"]));
  // A ROM with zero patches is a valid "repack" apply (Apply & Download offers "Patched .bin"); output must equal the input.
  cases.push(
    inContainer({
      expected: fs.readFileSync(base),
      files: [base],
      id: "no-patch/rom-only-passthrough",
      tags: ["no-patch", "repack"],
      title: "only a ROM, no patch: Apply still offers a download and the bytes equal the input",
    }),
  );
  cases.push(
    refuse(
      "refuse/rar5-multiarchive-part",
      "first volume of a multi-volume RAR as ROM",
      [path.resolve(HERE, "../../../../tests/fixtures/rar/rar5-part01.rar"), bps],
      ["rar", "multi-volume"],
    ),
  );
  void cliApply;
  void assert;
  return cases;
}
