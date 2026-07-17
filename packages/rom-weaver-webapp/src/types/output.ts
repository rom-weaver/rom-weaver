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
      /** True when the save was triggered by a direct user tap (live user activation); iOS PWA
       * share failures are surfaced instead of swallowed. */
      interactive?: boolean;
    };

type PublicOutput<TDestination> = {
  dispose: () => Promise<void>;
  fileName: string;
  getBlob?: () => Promise<Blob>;
  id: string;
  /** Pre-resolves whatever `saveAs` needs (e.g. the OPFS File snapshot) so a later
   * user-gesture download reaches `navigator.share` before the tap's activation expires. */
  prepareDownload?: () => Promise<void>;
  saveAs: (destination?: TDestination) => Promise<void>;
  size?: number;
  storage: OutputStorageKind;
  timing?: RuntimeTiming | null;
};

type BrowserSaveDestination = SaveDestination;

export type { BrowserSaveDestination, OutputStorageKind, PublicOutput, RuntimeTiming };
