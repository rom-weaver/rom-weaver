import type { RuntimeTiming } from "../../types/output.ts";
import type { AbsoluteVfsPath } from "./path.ts";

type VfsFileRef = {
  fileName?: string;
  mediaType?: string;
  path: AbsoluteVfsPath;
  vfs: LargeFileVfs;
};

type VfsOutputRef = {
  checksums?: Record<string, string>;
  dispose: () => Promise<void>;
  fileName: string;
  mediaType?: string;
  path: AbsoluteVfsPath;
  saveAs: (destination?: unknown) => Promise<void>;
  size: number;
  timing?: RuntimeTiming | null;
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
      checksums?: Record<string, string>;
      cleanup?: () => Promise<void> | void;
      mediaType?: string;
      size?: number;
      timing?: RuntimeTiming | null;
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
