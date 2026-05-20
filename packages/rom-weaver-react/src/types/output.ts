type OutputStorageKind = "blob" | "file" | "opfs";

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
};

type BrowserSaveDestination = SaveDestination;
type NodeSaveDestination = SaveDestination;

export type { BrowserSaveDestination, NodeSaveDestination, OutputStorageKind, PublicOutput, SaveDestination };
