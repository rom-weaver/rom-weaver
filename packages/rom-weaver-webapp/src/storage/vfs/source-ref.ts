import type { LargeFileVfs, VfsFileRef } from "./types.ts";

const isVfsFileRef = (value: unknown): value is VfsFileRef =>
  !!value &&
  typeof value === "object" &&
  "vfs" in value &&
  !!(value as { vfs?: unknown }).vfs &&
  typeof (value as { vfs?: unknown }).vfs === "object" &&
  "path" in value &&
  typeof (value as { path?: unknown }).path === "string";

const createVfsFileRef = (
  vfs: LargeFileVfs,
  filePath: string,
  options: {
    fileName?: string;
    mediaType?: string;
  } = {},
): VfsFileRef => ({
  ...(options.fileName ? { fileName: options.fileName } : null),
  ...(options.mediaType ? { mediaType: options.mediaType } : null),
  path: vfs.normalizePath(filePath),
  vfs,
});

export { createVfsFileRef, isVfsFileRef };
