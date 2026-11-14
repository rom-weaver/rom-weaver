import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createGunzip } from "node:zlib";

// GitHub generates source archives on request, and their bytes can change while
// the commit's contents do not, so the cache pins an archive by its revision
// and cannot pin it by hash. An entry is trusted once its gzip stream has been
// read to its checksum before publication; one that later fails to extract is
// evicted and fetched again.

// Callers in one process share a download instead of racing to publish the same file.
const pendingDownloads = new Map();

async function entryIdentity(archive) {
  try {
    const info = await stat(archive);
    return info.isFile() && info.size > 0
      ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`
      : "";
  } catch {
    return "";
  }
}

async function assertGzipComplete(file) {
  const discard = new Writable({ write: (_chunk, _encoding, done) => done() });
  await pipeline(createReadStream(file), createGunzip(), discard);
}

// Each writer fills its own temporary file and renames it into place, so a
// reader sees either no entry or a complete one, and writers never share a
// file. A writer that loses the rename to a concurrent one keeps the winner.
async function publishArchive({ archive, download }) {
  await mkdir(path.dirname(archive), { recursive: true });
  const partial = `${archive}.${process.pid}-${randomUUID()}.part`;
  try {
    await download(partial);
    await assertGzipComplete(partial);
    try {
      await rename(partial, archive);
    } catch (error) {
      // Windows refuses to replace a file another process has open.
      if (!(await entryIdentity(archive))) throw error;
    }
  } finally {
    await rm(partial, { force: true });
  }
}

function ensureArchive({ archive, download }) {
  const pending = pendingDownloads.get(archive);
  if (pending) return pending;
  const started = (async () => {
    if (!(await entryIdentity(archive))) await publishArchive({ archive, download });
  })();
  pendingDownloads.set(archive, started);
  const forget = () => pendingDownloads.delete(archive);
  started.then(forget, forget);
  return started;
}

// tar and zlib report a damaged or truncated archive with a `TAR_*` or `Z_*` code.
const isDamagedArchiveError = (error) => /^(?:TAR|Z)_/u.test(String(error?.code ?? ""));

// Run `use(archive)` on the cached archive, downloading it when absent. An entry
// that existed before this call and fails as damaged is removed, unless another
// process replaced it meanwhile, and fetched once more.
export async function withCachedArchive({ archive, download, use }) {
  const before = await entryIdentity(archive);
  await ensureArchive({ archive, download });
  try {
    return await use(archive);
  } catch (error) {
    if (!before || !isDamagedArchiveError(error)) throw error;
    if ((await entryIdentity(archive)) === before) await rm(archive, { force: true });
    await ensureArchive({ archive, download });
    return use(archive);
  }
}
