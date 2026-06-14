type OutputStorageKind = "blob" | "file" | "opfs";

type RuntimeTiming = {
  elapsedMs?: number;
  elapsedSeconds?: number;
};

type SaveDestination =
  | string
  | FileSystemFileHandle
  | {
      directory?: string;
      fileName?: string;
      fileHandle?: FileSystemFileHandle;
    };

type PublicOutput<TDestination> = {
  dispose: () => Promise<void>;
  fileName: string;
  getBlob?: () => Promise<Blob>;
  id: string;
  saveAs: (destination?: TDestination) => Promise<void>;
  size?: number;
  storage: OutputStorageKind;
  timing?: RuntimeTiming | null;
};

type BrowserSaveDestination = SaveDestination;

export type { BrowserSaveDestination, OutputStorageKind, PublicOutput, RuntimeTiming };
