import type { JsonValue } from "./runtime.ts";

type BinaryPayload = string | ArrayBuffer | ArrayBufferView | Blob | File;

type WorkflowFileNameLike = {
  fileName?: string;
  name?: string;
};

type WorkflowBinaryBackedFileLike = WorkflowFileNameLike & {
  _file?: BinaryPayload;
  _u8array?: JsonValue;
};

type WorkflowExtensionFileLike = {
  getExtension?: () => string;
};

// All source format metadata the Rust ingest/extract pass produces, in one optional bag. Populated
// once at the ingest/extract boundary (see `IngestRomAsset` / `attach_disc_group_details`); TS reads
// it via the format helpers and never derives or writes format metadata itself.
type SourceMetadata = {
  // Disc identity/structure.
  format?: string; // Rust `disc_format` verdict ("CD"/"GD-ROM"/"DVD") → display label
  mode?: string; // format-specific mode: "cd"/"dvd" (chd) or "iso"/"rvz" (rvz); drives codec selection only
  cuePath?: string;
  cueText?: string;
  gdiText?: string;
  groupId?: string;
  trackNumber?: number;
  splitBinAvailable?: boolean;
  // Source-filename precedence + container-format specifics for chd/rvz/z3ds create/extract.
  // Rust derives the live values; TS only forwards them.
  sourceFileName?: string; // unified original source name (chd/rvz/z3ds) for output naming
  underlyingMagic?: string; // z3ds payload magic
};

type WorkflowRomFileLike = WorkflowBinaryBackedFileLike & WorkflowExtensionFileLike & { metadata?: SourceMetadata };

export type { SourceMetadata, WorkflowRomFileLike };
