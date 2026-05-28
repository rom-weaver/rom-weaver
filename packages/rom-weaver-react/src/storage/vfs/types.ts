import type { AbsoluteVfsPath } from "./path.ts";

type VfsFileRef = {
  fileName?: string;
  mediaType?: string;
  path: AbsoluteVfsPath;
  vfs: LargeFileVfs;
};

type VfsOutputRef = {
  dispose: () => Promise<void>;
  fileName: string;
  mediaType?: string;
  path: AbsoluteVfsPath;
  saveAs: (destination?: unknown) => Promise<void>;
  size: number;
  vfs: LargeFileVfs;
};

type VfsStat = {
  path: AbsoluteVfsPath;
  size: number;
};

type LargeFileVfs = {
  readonly hostKind: "browser-opfs";
  readonly rootPath: AbsoluteVfsPath;
  createOutputRef: (
    path: string,
    fileName: string,
    options?: {
      cleanup?: () => Promise<void> | void;
      mediaType?: string;
      size?: number;
    },
  ) => Promise<VfsOutputRef>;
  normalizePath: (path: string) => AbsoluteVfsPath;
  read: (
    path: string,
    buffer: ArrayBuffer | ArrayBufferView,
    options?: {
      bufferOffset?: number;
      fileOffset?: number;
      length?: number;
    },
  ) => Promise<number>;
  remove: (path: string) => Promise<void>;
  saveAs: (path: string, destination?: unknown, fileName?: string) => Promise<void>;
  stat: (path: string) => Promise<VfsStat | null>;
  truncate: (path: string, size: number) => Promise<void>;
  write: (
    path: string,
    bytes: ArrayBuffer | ArrayBufferView | Uint8Array,
    options?: {
      fileOffset?: number;
    },
  ) => Promise<number>;
};

export type { LargeFileVfs, VfsFileRef, VfsOutputRef, VfsStat };
