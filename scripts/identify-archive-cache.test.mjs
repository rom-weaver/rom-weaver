import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { extractArchiveMembers } from "./build-identify-index.mjs";
import { publishArchive, withCachedArchive } from "./identify-archive-cache.mjs";
import { makeTempDir } from "./test-temp-dirs.mjs";

const run = promisify(execFile);
const PREFIX = "pinned-source";
const MEMBER = `${PREFIX}/dat/example.dat`;

const makeWork = () => makeTempDir("rw-archive-cache-");

// A real gzipped tar shaped like a GitHub source archive.
const buildArchive = async (work, body) => {
  const { create } = await import("tar");
  mkdirSync(join(work, "stage", PREFIX, "dat"), { recursive: true });
  writeFileSync(join(work, "stage", PREFIX, "dat", "example.dat"), body);
  const archive = join(work, "source.tar.gz");
  await create({ cwd: join(work, "stage"), file: archive, gzip: true }, [PREFIX]);
  return archive;
};

const copyFrom = (source) => (partial) => copyFile(source, partial);

const extractExample = (work) => async (archive) => {
  const sourceRoot = join(work, "extracted");
  mkdirSync(sourceRoot, { recursive: true });
  await extractArchiveMembers({ archive, members: [MEMBER], sourceRoot });
  return readFileSync(join(sourceRoot, "dat", "example.dat"), "utf8");
};

const leftovers = (dir) => readdirSync(dir).filter((name) => name.endsWith(".part"));

test("concurrent callers in one process share a single download", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "payload");
  const archive = join(work, "cache", "libretro", "rev.tar.gz");
  let downloads = 0;
  const download = async (partial) => {
    downloads += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await copyFile(source, partial);
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      withCachedArchive({ archive, download, use: extractExample(work) }),
    ),
  );
  assert.deepEqual(results, ["payload", "payload", "payload", "payload"]);
  assert.equal(downloads, 1);
  assert.deepEqual(leftovers(join(work, "cache", "libretro")), []);
});

test("separate processes publishing the same archive each finish with one intact entry", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "payload");
  const cacheDir = join(work, "cache");
  const script = `
    import { readdirSync, writeFileSync } from "node:fs";
    import { copyFile } from "node:fs/promises";
    import { withCachedArchive } from ${JSON.stringify(new URL("./identify-archive-cache.mjs", import.meta.url).href)};
    await withCachedArchive({
      archive: process.argv[1],
      download: async (partial) => {
        writeFileSync(process.argv[3] + "/" + process.pid, partial);
        const deadline = Date.now() + 30_000;
        while (readdirSync(process.argv[3]).length < 3 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await copyFile(process.argv[2], partial);
      },
      use: async () => {},
    });
  `;
  const archive = join(cacheDir, "libretro", "rev.tar.gz");
  const partialsDir = join(work, "partials");
  mkdirSync(partialsDir);
  const workers = Array.from({ length: 3 }, () =>
    run(process.execPath, ["--input-type=module", "-e", script, archive, source, partialsDir]),
  );
  await Promise.all(workers);
  const partials = readdirSync(partialsDir).map((name) => readFileSync(join(partialsDir, name), "utf8"));
  assert.equal(new Set(partials).size, 3, "each process downloads into its own temporary file");
  assert.deepEqual(leftovers(join(cacheDir, "libretro")), []);
  assert.equal(await extractExample(work)(archive), "payload");
});

test("an interrupted download publishes nothing and the next call fetches again", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "payload");
  const archive = join(work, "cache", "libretro", "rev.tar.gz");
  const interrupted = async (partial) => {
    writeFileSync(partial, readFileSync(source).subarray(0, 20));
    throw new Error("connection reset");
  };
  await assert.rejects(
    withCachedArchive({ archive, download: interrupted, use: extractExample(work) }),
    /connection reset/u,
  );
  assert.deepEqual(readdirSync(join(work, "cache", "libretro")), []);
  const recovered = await withCachedArchive({
    archive,
    download: copyFrom(source),
    use: extractExample(work),
  });
  assert.equal(recovered, "payload");
});

test("a download that ends early with success is refused rather than published", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "x".repeat(50_000));
  const archive = join(work, "cache", "libretro", "rev.tar.gz");
  const truncated = async (partial) => {
    const bytes = readFileSync(source);
    writeFileSync(partial, bytes.subarray(0, bytes.length - 40));
  };
  await assert.rejects(withCachedArchive({ archive, download: truncated, use: async () => {} }));
  assert.deepEqual(readdirSync(join(work, "cache", "libretro")), []);
});

test("an empty, truncated, or garbage cache entry is replaced by a fresh download", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "payload".repeat(10_000));
  const whole = readFileSync(source);
  const damaged = {
    empty: Buffer.alloc(0),
    garbage: Buffer.from("not a gzip stream at all"),
    truncated: whole.subarray(0, Math.floor(whole.length / 2)),
  };
  for (const [name, bytes] of Object.entries(damaged)) {
    const archive = join(work, name, "libretro", "rev.tar.gz");
    mkdirSync(join(work, name, "libretro"), { recursive: true });
    writeFileSync(archive, bytes);
    let downloads = 0;
    const download = async (partial) => {
      downloads += 1;
      await copyFile(source, partial);
    };
    const text = await withCachedArchive({ archive, download, use: extractExample(work) });
    assert.equal(text, "payload".repeat(10_000), name);
    assert.equal(downloads, 1, name);
    assert.equal(statSync(archive).size, whole.length, name);
  }
});

test("a freshly downloaded archive that fails to extract is not fetched a second time", async () => {
  const work = makeWork();
  const archive = join(work, "cache", "libretro", "rev.tar.gz");
  let downloads = 0;
  const damagedUse = async () => {
    throw Object.assign(new Error("bad archive"), { code: "TAR_BAD_ARCHIVE" });
  };
  const source = await buildArchive(work, "payload");
  const download = async (partial) => {
    downloads += 1;
    await copyFile(source, partial);
  };
  await assert.rejects(withCachedArchive({ archive, download, use: damagedUse }), /bad archive/u);
  assert.equal(downloads, 1);
});

test("a cached archive that lacks a member keeps its entry and reports the missing member", async () => {
  const work = makeWork();
  const source = await buildArchive(work, "payload");
  const archive = join(work, "cache", "libretro", "rev.tar.gz");
  await withCachedArchive({ archive, download: copyFrom(source), use: async () => {} });
  const wantsMissing = async (path) => {
    await extractArchiveMembers({
      archive: path,
      members: [`${PREFIX}/dat/absent.dat`],
      sourceRoot: join(work, "extracted"),
    });
  };
  mkdirSync(join(work, "extracted"), { recursive: true });
  await assert.rejects(
    withCachedArchive({
      archive,
      download: async () => assert.fail("must not download again"),
      use: wantsMissing,
    }),
    /is missing: pinned-source\/dat\/absent\.dat/u,
  );
  assert.ok(statSync(archive).size > 0);
});

test("publishArchive publishes what its verify step accepts and nothing it rejects", async () => {
  const work = makeWork();
  const archive = join(work, "cache", "plain.bin");
  const download = (partial) => writeFileSync(partial, "not gzip");
  await assert.rejects(
    publishArchive({
      archive,
      download,
      verify: () => {
        throw new Error("rejected by the caller");
      },
    }),
    /rejected by the caller/u,
  );
  assert.deepEqual(readdirSync(join(work, "cache")), []);
  await publishArchive({ archive, download, verify: () => {} });
  assert.equal(readFileSync(archive, "utf8"), "not gzip");
  assert.deepEqual(readdirSync(join(work, "cache")), ["plain.bin"]);
});
