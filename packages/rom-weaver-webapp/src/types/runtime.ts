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

type BrowserFileLike = Blob & {
  name?: string;
  type?: string;
  lastModified?: number;
  webkitRelativePath?: string;
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

export type {
  ArchiveEntryInput,
  BrowserFileLike,
  JsonObject,
  JsonRecord,
  JsonValue,
  ProgressEvent,
  StringNumber,
  StringNumberBoolean,
};
