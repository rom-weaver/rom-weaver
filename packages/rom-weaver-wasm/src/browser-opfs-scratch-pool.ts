import {
  BrowserMemoryRandomAccessFile,
  BrowserOpfsRandomAccessFile,
} from './browser-opfs-io-adapters.ts';
import {
  DEFAULT_SCRATCH_FILE_POOL_SIZE,
  SCRATCH_DIRECTORY_NAME,
  SCRATCH_FILE_CREATE_CONCURRENCY,
} from './browser-opfs-constants.ts';
import { openSyncAccessHandle, writableSyncAccessMode } from './browser-opfs-sync-access.ts';
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserSyncAccessMode,
} from './browser-opfs-runtime-types.ts';
import type { RandomAccessFileLike } from './browser-opfs-wasi-file-inode.ts';

export async function createScratchFilePool({
  closeables,
  directoryHandle,
  scratchFilePoolSize,
  syncAccessMode,
}: {
  closeables: RandomAccessFileLike[];
  directoryHandle: FileSystemDirectoryHandleLike;
  scratchFilePoolSize?: unknown;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
}) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  if (count === 0) {
    return { directoryHandle: null, files: [], pool: [] };
  }

  const scratchDirectoryHandle = await directoryHandle.getDirectoryHandle(
    SCRATCH_DIRECTORY_NAME,
    { create: true },
  ) as FileSystemDirectoryHandleLike;
  const token = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const files = new Array<BrowserOpfsRandomAccessFile>(count);
  await forEachRangeConcurrently({
    count,
    limit: Math.min(count, SCRATCH_FILE_CREATE_CONCURRENCY),
    async run(index: number) {
      const scratchName = `${token}-${index}.tmp`;
      const fileHandle = await scratchDirectoryHandle.getFileHandle(scratchName, { create: true });
      const syncHandle = await openSyncAccessHandle({
        fileHandle,
        mode: writableSyncAccessMode(syncAccessMode),
      });
      const file = new BrowserOpfsRandomAccessFile(syncHandle, { scratchName });
      files[index] = file;
      closeables.push(file);
    },
  });
  return {
    directoryHandle: scratchDirectoryHandle,
    files,
    pool: [...files],
  };
}

async function forEachRangeConcurrently({
  count,
  limit,
  run,
}: {
  count: number;
  limit: number;
  run: (index: number) => Promise<void>;
}) {
  const total = Math.max(0, Number(count) || 0);
  if (total === 0) return;
  const parallel = Math.max(1, Math.floor(Number(limit) || 1));
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(parallel, total);
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        await run(index);
      }
    })());
  }
  await Promise.all(workers);
}

export function createMemoryScratchFilePool({
  closeables,
  scratchFilePoolSize,
}: {
  closeables: RandomAccessFileLike[];
  scratchFilePoolSize?: unknown;
}) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  const files: BrowserMemoryRandomAccessFile[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = new BrowserMemoryRandomAccessFile();
    files.push(file);
    closeables.push(file);
  }
  return {
    directoryHandle: null,
    files,
    pool: [...files],
  };
}

export function normalizeScratchFilePoolSize(value?: unknown) {
  if (value === undefined || value === null) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  return Math.floor(parsed);
}
