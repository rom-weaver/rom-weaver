import type { Timing } from "../lib/progress/timing.ts";

type CleanupCallback = () => void | Promise<void>;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject | Blob | ArrayBufferLike | Uint8Array;
type JsonRecord = {
  [key: string]: JsonValue;
};
type JsonObject = {
  [key: string]: JsonValue | undefined;
};
type StringNumber = string | number;
type StringNumberBoolean = StringNumber | boolean;

type ProgressEvent = {
  label?: string;
  percent?: number | null;
  resolvedFileName?: string;
  [key: string]: JsonValue | undefined;
};

type ProgressCallback = (progress: ProgressEvent) => void;

type BrowserFileLike = Blob & {
  name?: string;
  type?: string;
  lastModified?: number;
  webkitRelativePath?: string;
};

type ArchiveEntry = {
  filename: string;
  fileName?: string;
  name?: string;
  fileType?: string;
  size?: number;
  mtime?: number;
  lastModified?: number;
  archiveEntryType?: string;
  archiveFile?: BrowserFileLike;
  archiveFileName?: string | null;
  archiveSource?: JsonObject;
  archiveBuffer?: ArrayBufferLike | null;
  [key: string]: JsonValue | undefined;
};

type ArchiveEntryInput = {
  fileName?: string;
  filename?: string;
  name?: string;
  text?: StringNumber;
  u8array?: Uint8Array;
  arrayBuffer?: ArrayBufferLike | Uint8Array;
  data?: ArrayBufferLike | Uint8Array;
  filePath?: string;
  file?: BrowserFileLike & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  lastModified?: number;
  mtime?: number;
  cleanup?: CleanupCallback;
};

type MaterializedArchiveEntry = {
  filename: string;
  data: Uint8Array | BrowserFileLike;
  filePath?: string;
  mtime: number;
};

type ArchiveExtractionResult = {
  blob?: Blob;
  cleanup?: CleanupCallback;
  cleanupPaths?: string[] | null;
  data?: JsonValue | ArrayBufferLike;
  entry?: ArchiveEntry;
  file?: BrowserFileLike | ArrayBufferLike;
  fileHandle?: FileSystemFileHandle | null;
  fileName?: string;
  filePath?: string;
  size?: number;
  timing?: Partial<Timing> | null;
  u8array?: Uint8Array;
};

type NormalizedArchiveExtractionResult = {
  filename: string;
  file?: BrowserFileLike;
  blob?: BrowserFileLike;
  data?: Uint8Array;
  u8array?: Uint8Array;
  fileName: string;
  entry: { filename?: string } | null;
  size?: number;
  timing: Partial<Timing> | null;
  cleanupPaths: string[] | null;
  cleanup?: CleanupCallback;
};

type BrowserDownload = {
  data: BlobPart;
  fileName: string;
  cleanup?: CleanupCallback;
};

export type {
  ArchiveEntry,
  ArchiveEntryInput,
  ArchiveExtractionResult,
  BrowserDownload,
  BrowserFileLike,
  CleanupCallback,
  JsonObject,
  JsonPrimitive,
  JsonRecord,
  JsonValue,
  MaterializedArchiveEntry,
  NormalizedArchiveExtractionResult,
  ProgressCallback,
  ProgressEvent,
  StringNumber,
  StringNumberBoolean,
};
