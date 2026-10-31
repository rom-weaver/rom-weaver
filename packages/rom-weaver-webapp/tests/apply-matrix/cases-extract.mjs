// Extract route (extract-files): every archive / compressed-stream / disc container input type.
// Expected content comes from independent tools (7z/bsdtar, dolphin-tool, chdman) or from payload
// fixtures built next to the container; the native CLI is the tiebreaker.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cliPath } from "../fixtures/apply-matrix/generate.mjs";
import { prng, sha256 } from "../fixtures/apply-matrix/encoders.mjs";
import { mainText, visibleErrors } from "./lib/flows.mjs";
import { EXH_CACHE, FIXTURE_ROOT } from "./lib/gen.mjs";
import { assert, Skip } from "./lib/scenario.mjs";
import { chdInspect, extractWithHost, have, rvzInspect, withTempDir } from "./lib/tools.mjs";
import { MOBILE, newSession, stage } from "./lib/ui.mjs";

const INPUT = "#extract-input-picker";
const CTR = path.join(FIXTURE_ROOT, "ctr");
const DISC = path.join(FIXTURE_ROOT, "disc");
const GC = path.join(FIXTURE_ROOT, "reference/gc");
const read = (file) => fs.readFileSync(file);

async function openExtract(h, files, { device = null } = {}) {
  const session = await newSession(h.browser, h.baseUrl, { device, ready: INPUT, route: "extract-files" });
  await stage(session.page, files, INPUT);
  return session;
}

/** Wait until the Files step lists entries (ready) or an error notice shows. */
async function settleExtract(page, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const download = Array.from(document.querySelectorAll("main button")).find((b) =>
        /^download/i.test(b.innerText.trim()),
      );
      const rows = document.querySelectorAll("main input.pick-input").length;
      const errors = Array.from(
        document.querySelectorAll("[id$='-message'], [role='alert'], .notice.error, .notice.bad"),
      )
        .filter((e) => e.getClientRects().length && e.innerText.trim())
        .map((e) => e.innerText.replace(/\s+/g, " ").trim());
      const retry = Array.from(document.querySelectorAll("main button")).some((b) =>
        /extract again/i.test(b.innerText),
      );
      return { download: download ? download.innerText.replace(/\s+/g, " ").trim() : null, errors, retry, rows };
    });
    if (state.download && !/^download 0/i.test(state.download)) return { kind: "ready", ...state };
    if (state.errors.length || state.retry) return { kind: "error", ...state };
    await page.waitForTimeout(500);
  }
  return { kind: "timeout" };
}

async function listEntries(page) {
  return page.evaluate(() => {
    const text = document.querySelector("main")?.innerText || "";
    return text;
  });
}

async function download(page, outDir) {
  const button = page.locator("main button", { hasText: /^download/i }).first();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 90_000 }), button.click()]);
  const saved = path.join(outDir, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(saved);
  return { bytes: read(saved), name: dl.suggestedFilename() };
}

const walk = (root) => {
  const files = [];
  const rec = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) rec(full);
      else files.push({ bytes: read(full), name: path.relative(root, full) });
    }
  };
  rec(root);
  return files;
};

function bsdtarExpected(file) {
  if (!have("bsdtar")) return null;
  return withTempDir((dir) => {
    const run = spawnSync("bsdtar", ["-xf", file, "-C", dir], { encoding: "utf8" });
    return run.status === 0 ? walk(dir) : null;
  });
}
function streamExpected(file) {
  const tool = {
    ".bz2": ["bzip2", "-dc"],
    ".gz": ["gzip", "-dc"],
    ".lzma": ["xz", "--format=lzma", "-dc"],
    ".lz4": ["lz4", "-dc"],
    ".xz": ["xz", "-dc"],
    ".zst": ["zstd", "-dc"],
  }[path.extname(file)];
  if (!(tool && have(tool[0]))) return null;
  const run = spawnSync(tool[0], [...tool.slice(1), file], { maxBuffer: 1 << 28 });
  return run.status === 0 ? [{ bytes: run.stdout, name: path.basename(file, path.extname(file)) }] : null;
}
function nativeExpected(file) {
  const bin = cliPath();
  if (!bin) return null;
  return withTempDir((dir) => {
    const run = spawnSync(bin, ["extract", "--input", file, "--output", dir, "--no-progress"], { encoding: "utf8" });
    return run.status === 0 ? walk(dir) : null;
  });
}

export function extractCases() {
  const cases = [];
  const have3 = (file) => fs.existsSync(file);

  /** An input whose expected entries are computed. `expected()` returns [{ name, bytes }] or null. */
  const positive = (id, file, expected, { nested = false, extraOk = false } = {}) =>
    cases.push({
      group: "extract",
      id: `extract/${id}`,
      tags: ["extract", id.split("/")[0]],
      title: `extract ${path.basename(file)}`,
      skip: have3(file) ? undefined : `fixture missing: ${file}`,
      async run(h) {
        const want = expected();
        if (!want) throw new Error("no independent expectation available");
        const session = await openExtract(h, [file]);
        try {
          const state = await settleExtract(session.page);
          if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
          if (state.kind !== "ready")
            throw new Error(
              `extract ${state.kind}: ${(state.errors || []).join(" | ")} ${await mainText(session.page)}`,
            );
          const out = await download(session.page, h.caseDir);
          let got;
          if (want.length > 1 || extraOk || /\.zip$/i.test(out.name)) {
            const unpacked = extractWithHost(out.bytes, out.name);
            assert(!unpacked.error, `download ${out.name} is not a valid zip: ${unpacked.error}`);
            got = unpacked.files;
          } else got = [{ bytes: out.bytes, name: out.name }];
          const gotShas = got.map((f) => sha256(f.bytes)).sort();
          const wantShas = want.map((f) => sha256(f.bytes)).sort();
          if (extraOk) {
            assert(
              wantShas.every((sha) => gotShas.includes(sha)),
              `expected content missing: got [${got.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}] want [${want.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}]`,
            );
            return `${out.name}: ${got.map((f) => f.name).join("+")}`;
          }
          assert(
            gotShas.length === wantShas.length && gotShas.every((sha, i) => sha === wantShas[i]),
            `content mismatch: got [${got.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}] want [${want.map((f) => `${f.name}:${f.bytes.length}`).join(", ")}]`,
          );
          void nested;
          return `${out.name}: ${got.length} file(s)`;
        } finally {
          await session.context.close();
        }
      },
    });

  // archives and tar flavours
  for (const name of [
    "rw.zip",
    "rw-store.zip",
    "rw-zstd.zip",
    "zip-deflate.zip",
    "zip-store.zip",
    "bsdtar.zip",
    "rw.7z",
    "bsdtar.7z",
    "plain.tar",
    "plain.tar.gz",
    "plain.tar.bz2",
    "plain.tar.xz",
    "plain.tgz",
    "plain.tbz2",
    "plain.txz",
    "subdir.zip",
    "two-roms.zip",
  ])
    positive(
      `archive/${name}`,
      path.join(CTR, name),
      () => bsdtarExpected(path.join(CTR, name)) ?? nativeExpected(path.join(CTR, name)),
    );
  for (const name of ["game.bin.gz", "game.bin.bz2", "game.bin.xz", "game.bin.zst"])
    positive(`stream/${name}`, path.join(CTR, name), () => streamExpected(path.join(CTR, name)));
  positive("nested/nested-outer.zip", path.join(CTR, "nested-outer.zip"), () =>
    bsdtarExpected(path.join(CTR, "plain.tar")),
  );
  positive("nested/nested-tgz-7z.tgz", path.join(CTR, "nested-tgz-7z.tgz"), () =>
    bsdtarExpected(path.join(CTR, "plain.tar")),
  );

  // disc containers with a payload fixture next to them
  for (const [id, container, payload] of [
    ["cso", "cso.cso", "cso.payload.iso"],
    ["ciso", "ciso.ciso", "ciso.payload.iso"],
    ["wbfs", "wbfs.wbfs", "wbfs.payload.iso"],
    ["tgc", "tgc.tgc", "tgc.payload.iso"],
    ["pbp", "pbp.pbp", "pbp.payload.bin"],
  ])
    positive(
      `disc/${id}`,
      path.join(DISC, container),
      () => (have3(path.join(DISC, payload)) ? [{ bytes: read(path.join(DISC, payload)), name: payload }] : null),
      { extraOk: id === "pbp" },
    );
  positive("disc/xiso", path.join(DISC, "xiso.xiso"), () => nativeExpected(path.join(DISC, "xiso.xiso")));
  positive("disc/z3ds", path.join(DISC, "made.z3ds"), () => nativeExpected(path.join(DISC, "made.z3ds")));
  positive("disc/rvz-made", path.join(DISC, "made.rvz"), () => {
    const result = have("dolphin-tool") ? rvzInspect(read(path.join(DISC, "made.rvz"))) : null;
    return result?.ok ? [{ bytes: result.bytes, name: "x.iso" }] : null;
  });
  positive(
    "disc/chd-made",
    path.join(DISC, "made.chd"),
    () => {
      if (!have("chdman")) return null;
      return withTempDir((dir) => {
        const run = spawnSync(
          "chdman",
          [
            "extractcd",
            "-i",
            path.join(DISC, "made.chd"),
            "-o",
            path.join(dir, "o.cue"),
            "-ob",
            path.join(dir, "o.bin"),
          ],
          { encoding: "utf8" },
        );
        if (run.status === 0) return [{ bytes: read(path.join(dir, "o.bin")), name: "o.bin" }];
        const raw = chdInspect(read(path.join(DISC, "made.chd")));
        return raw?.ok && raw.bytes ? [{ bytes: raw.bytes, name: "x.bin" }] : null;
      });
    },
    { extraOk: true },
  );

  // GCZ block sizes and WIA variants vs dolphin-tool
  const gczDir = path.join(GC, "gcz");
  const wiaDir = path.join(GC, "wia");
  const dolphinIso = (file) => {
    if (!have("dolphin-tool")) return null;
    return withTempDir((dir) => {
      const out = path.join(dir, "o.iso");
      const run = spawnSync(
        "dolphin-tool",
        ["convert", "-u", path.join(dir, "u"), "-i", file, "-o", out, "-f", "iso"],
        { encoding: "utf8" },
      );
      return run.status === 0 && fs.existsSync(out) ? [{ bytes: read(out), name: "x.iso" }] : null;
    });
  };
  if (fs.existsSync(gczDir))
    for (const name of fs
      .readdirSync(gczDir)
      .filter((f) => f.endsWith(".gcz"))
      .sort())
      positive(`disc/gcz/${name}`, path.join(gczDir, name), () => dolphinIso(path.join(gczDir, name)));
  if (fs.existsSync(wiaDir))
    for (const name of fs
      .readdirSync(wiaDir)
      .filter((f) => f.endsWith(".wia"))
      .sort())
      positive(`disc/wia/${name}`, path.join(wiaDir, name), () => dolphinIso(path.join(wiaDir, name)));

  // negatives: a clear message, no hang, no download
  const negative = (id, file, want) =>
    cases.push({
      group: "extract",
      id: `extract/refuse/${id}`,
      tags: ["extract", "refuse", id],
      title: `extract ${path.basename(file)}: refused with a visible message`,
      skip: have3(file) ? undefined : `fixture missing: ${file}`,
      async run(h) {
        const session = await openExtract(h, [file]);
        try {
          const state = await settleExtract(session.page, 60_000);
          if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
          if (state.kind === "timeout") throw new Error(`UI hung: ${await mainText(session.page)}`);
          if (state.kind === "ready")
            throw new Error(`accepted an invalid archive: ${await listEntries(session.page)}`.slice(0, 300));
          const text = (state.errors || []).join(" | ") || (await mainText(session.page));
          assert(want.test(text), `message ${JSON.stringify(text.slice(0, 200))} does not match ${want}`);
          return text.slice(0, 160);
        } finally {
          await session.context.close();
        }
      },
    });
  negative("game.bin.lzma", path.join(CTR, "game.bin.lzma"), /not an archive|unsupported|cannot/i); // .lzma (alone) is not a registered container
  negative("encrypted.zip", path.join(CTR, "encrypted.zip"), /passphrase|password|encrypt/i);
  negative("truncated.zip", path.join(CTR, "truncated.zip"), /truncat|incomplete|corrupt|read|invalid|fail/i);
  negative("truncated.7z", path.join(CTR, "truncated.7z"), /truncat|incomplete|corrupt|read|invalid|fail|unsupported/i);
  negative(
    "truncated.tar.gz",
    path.join(CTR, "truncated.tar.gz"),
    /truncat|incomplete|corrupt|read|invalid|fail|unexpected/i,
  );
  negative("garbage.zip", path.join(CTR, "garbage.zip"), /unsupported|invalid|not a|corrupt|read|fail|no output/i);
  negative("garbage.7z", path.join(CTR, "garbage.7z"), /unsupported|invalid|not a|corrupt|read|fail|no output/i);
  negative("empty.zip", path.join(CTR, "empty.zip"), /no output|empty|nothing|no files/i);
  negative(
    "split-wbfs-missing",
    path.join(DISC, "split-missing/disc.wbfs"),
    /split|part|missing|wbf1|incomplete|invalid|fail|unsupported/i,
  );

  // synthetic edge inputs
  const synthetic = (id, name, bytes, check) =>
    cases.push({
      group: "extract",
      id: `extract/edge/${id}`,
      tags: ["extract", "edge", id],
      title: `extract ${id}`,
      async run(h) {
        const session = await openExtract(h, [{ buffer: bytes, name }]);
        try {
          const state = await settleExtract(session.page, 60_000);
          if (session.pageErrors.length) throw new Error(`page error ${String(session.pageErrors[0])}`);
          return await check({ h, session, state });
        } finally {
          await session.context.close();
        }
      },
    });
  synthetic("zero-byte-zip", "empty.zip", Buffer.alloc(0), async ({ session, state }) => {
    assert(state.kind !== "ready" && state.kind !== "timeout", `zero-byte zip: ${state.kind}`);
    const text = (state.errors || []).join(" | ") || (await mainText(session.page));
    return text.slice(0, 160);
  });
  synthetic("one-byte-7z", "x.7z", Buffer.from([0x37]), async ({ session, state }) => {
    assert(state.kind !== "ready" && state.kind !== "timeout", `one-byte 7z: ${state.kind}`);
    return ((state.errors || []).join(" | ") || (await mainText(session.page))).slice(0, 160);
  });
  synthetic(
    "plain-text-as-zip",
    "notes.zip",
    Buffer.from("this is not a zip file at all\n".repeat(20)),
    async ({ session, state }) => {
      assert(state.kind !== "ready" && state.kind !== "timeout", `text-as-zip: ${state.kind}`);
      return ((state.errors || []).join(" | ") || (await mainText(session.page))).slice(0, 160);
    },
  );
  synthetic("unsupported-extension", "thing.xyz", Buffer.from("hello world"), async ({ session, state }) => {
    assert(state.kind !== "timeout", `unsupported extension hung: ${await mainText(session.page)}`);
    return `${state.kind}: ${((state.errors || []).join(" | ") || (await mainText(session.page))).slice(0, 160)}`;
  });
  synthetic("unicode-name-zip", "ゲーム é 🎮.zip", read(path.join(CTR, "rw.zip")), async ({ h, session, state }) => {
    assert(state.kind === "ready", `${state.kind}: ${(state.errors || []).join(" | ")}`);
    const out = await download(session.page, h.caseDir);
    assert(out.bytes.length === 40960, `size ${out.bytes.length}`);
    return out.name;
  });

  // multipart sets built with host tools: either extracted correctly or refused with a message; never a
  // hang, never corrupt output.
  const multipart = (id, build, names) =>
    cases.push({
      group: "extract",
      id: `extract/multipart/${id}`,
      tags: ["extract", "multipart", id],
      title: `multipart ${id}: extracted correctly or refused with a message`,
      async run(h) {
        const rom = Buffer.from(prng(150_000, 0x77));
        const dir = path.join(EXH_CACHE, "multipart", id);
        if (!fs.existsSync(path.join(dir, names[0]))) {
          fs.mkdirSync(dir, { recursive: true });
          if (!build(dir, rom)) throw new Skip("host tool for building this multipart set is missing");
        }
        const files = names.map((name) => path.join(dir, name));
        const session = await openExtract(h, files);
        try {
          const state = await settleExtract(session.page, 60_000);
          assert(!session.pageErrors.length, `page error ${String(session.pageErrors[0])}`);
          assert(state.kind !== "timeout", `UI hung: ${await mainText(session.page)}`);
          if (state.kind === "error") return `refused: ${(state.errors || []).join(" | ").slice(0, 200)}`;
          const out = await download(session.page, h.caseDir);
          const got = /\.zip$/i.test(out.name)
            ? extractWithHost(out.bytes, out.name).files.map((f) => f.bytes)
            : [out.bytes];
          assert(
            got.some((bytes) => sha256(bytes) === sha256(rom)),
            `extracted content differs from the original (${got.map((b) => b.length).join(",")} B)`,
          );
          return `extracted ${out.name}`;
        } finally {
          await session.context.close();
        }
      },
    });
  multipart(
    "7z-001",
    (dir, rom) => {
      if (!have("7z")) return false;
      fs.writeFileSync(path.join(dir, "rom.bin"), rom);
      return spawnSync("7z", ["a", "-v50k", "-bd", path.join(dir, "set.7z"), path.join(dir, "rom.bin")]).status === 0;
    },
    ["set.7z.001", "set.7z.002", "set.7z.003"],
  );
  multipart(
    "zip-z01",
    (dir, rom) => {
      if (!have("zip")) return false;
      fs.writeFileSync(path.join(dir, "rom.bin"), rom);
      return spawnSync("zip", ["-s", "64k", "-q", path.join(dir, "set.zip"), "rom.bin"], { cwd: dir }).status === 0;
    },
    ["set.z01", "set.z02", "set.zip"],
  );
  multipart(
    "tar-gz-split",
    (dir, rom) => {
      fs.writeFileSync(path.join(dir, "rom.bin"), rom);
      const tarball = spawnSync("bsdtar", ["-czf", path.join(dir, "set.tar.gz"), "-C", dir, "rom.bin"]);
      if (tarball.status !== 0) return false;
      return (
        spawnSync("split", ["-b", "60000", path.join(dir, "set.tar.gz"), path.join(dir, "set.tar.gz.part")]).status ===
        0
      );
    },
    ["set.tar.gz.partaa", "set.tar.gz.partab", "set.tar.gz.partac"],
  );

  // select-subset + repeated runs + mobile + replace input
  cases.push({
    group: "extract",
    id: "extract/select-subset/two-roms.zip",
    tags: ["extract", "select"],
    title: "uncheck one of two files: only the checked file downloads (single file, not a zip)",
    skip: have3(path.join(CTR, "two-roms.zip")) ? undefined : "fixture missing",
    async run(h) {
      const session = await openExtract(h, [path.join(CTR, "two-roms.zip")]);
      try {
        const state = await settleExtract(session.page);
        assert(state.kind === "ready" && state.rows >= 2, `not ready: ${state.kind} rows=${state.rows}`);
        await session.page.locator("main .pick-row").nth(1).click();
        await session.page.waitForTimeout(400);
        const label = await session.page
          .locator("main button", { hasText: /^download/i })
          .first()
          .innerText();
        assert(/download 1 file/i.test(label), `button says ${JSON.stringify(label)} after unchecking one of two`);
        const out = await download(session.page, h.caseDir);
        assert(out.bytes.length === 40960, `downloaded ${out.bytes.length} B (${out.name})`);
        return out.name;
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "extract",
    id: "extract/replace-input/zip-then-tar",
    tags: ["extract", "replace"],
    title: "extract a zip, then drop a tar.gz over it: the list is replaced, not appended",
    skip: have3(path.join(CTR, "rw.zip")) ? undefined : "fixture missing",
    async run(h) {
      const session = await openExtract(h, [path.join(CTR, "two-roms.zip")]);
      try {
        const first = await settleExtract(session.page);
        assert(first.kind === "ready" && first.rows === 2, `first: ${first.kind} rows=${first.rows}`);
        await stage(session.page, [path.join(CTR, "plain.tar.gz")], INPUT);
        await session.page.waitForTimeout(3000);
        const second = await settleExtract(session.page);
        assert(second.kind === "ready", `second: ${second.kind} ${(second.errors || []).join("|")}`);
        assert(
          second.rows === 1,
          `after replacing the input the list shows ${second.rows} files (stale entries kept?)`,
        );
        return `rows ${first.rows} -> ${second.rows}`;
      } finally {
        await session.context.close();
      }
    },
  });
  cases.push({
    group: "extract",
    id: "extract/mobile/rw.zip",
    tags: ["extract", "mobile"],
    title: "extract on a 390x780 touch viewport",
    async run(h) {
      const session = await openExtract(h, [path.join(CTR, "rw.zip")], { device: MOBILE });
      try {
        const state = await settleExtract(session.page);
        assert(state.kind === "ready", `${state.kind}: ${(state.errors || []).join(" | ")}`);
        const overflow = await session.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 2, `horizontal overflow ${overflow}px`);
        await session.page.screenshot({ fullPage: true, path: path.join(h.caseDir, "mobile.png") });
        const out = await download(session.page, h.caseDir);
        assert(out.bytes.length === 40960, `size ${out.bytes.length}`);
        return out.name;
      } finally {
        await session.context.close();
      }
    },
  });
  void visibleErrors;
  return cases;
}
