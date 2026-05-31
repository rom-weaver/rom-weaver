import type { VfsFileRef } from "../storage/vfs/types.ts";

type DirectSource = string | Blob | FileSystemFileHandle | VfsFileRef;
type BrowserDirectSource = Blob | FileSystemFileHandle;

type SourceObject<TSource extends DirectSource = DirectSource> = {
  fileName?: string;
  mediaType?: string;
  name?: string;
  size?: number;
  type?: string;
  source: TSource;
  data?: TSource;
};

type SourceRef = DirectSource | SourceObject;

type BrowserSourceObject = SourceObject<BrowserDirectSource>;
type BrowserSourceRef = BrowserDirectSource | BrowserSourceObject;

export type { BrowserDirectSource, BrowserSourceObject, BrowserSourceRef, DirectSource, SourceObject, SourceRef };
