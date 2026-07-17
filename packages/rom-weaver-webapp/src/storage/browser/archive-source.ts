import type { BrowserFileLike, JsonObject } from "../../types/runtime.ts";
import type { DirectSource } from "../../types/source.ts";

type ArchiveSourceValue =
  | DirectSource
  | ArrayBufferLike
  | ArrayBufferView
  | JsonObject
  | {
      _file?: BrowserFileLike;
      _u8array?: Uint8Array;
      fileName?: string;
      name?: string;
    }
  | null
  | undefined;

export type { ArchiveSourceValue };
