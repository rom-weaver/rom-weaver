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

type WorkflowChdSourceMetadata = {
  _chdMode?: "cd" | "dvd" | string;
  _chdCueText?: string;
};

type WorkflowRvzSourceMetadata = {
  _rvzSourceFileName?: string;
  _rvzMode?: string;
};

type WorkflowZ3dsSourceMetadata = {
  _z3dsSourceFileName?: string;
  _z3dsUnderlyingMagic?: string;
  _z3dsMetadata?: JsonValue;
};

type WorkflowRomFileLike = WorkflowBinaryBackedFileLike &
  WorkflowExtensionFileLike &
  WorkflowChdSourceMetadata &
  WorkflowRvzSourceMetadata &
  WorkflowZ3dsSourceMetadata;

type PatchFileEntry<TFile = BinaryPayload> = {
  patchFile?: TFile;
  patchFilePath?: string;
  patchFileName?: string;
};

export type {
  BinaryPayload,
  PatchFileEntry,
  WorkflowBinaryBackedFileLike,
  WorkflowChdSourceMetadata,
  WorkflowExtensionFileLike,
  WorkflowFileNameLike,
  WorkflowRomFileLike,
  WorkflowRvzSourceMetadata,
  WorkflowZ3dsSourceMetadata,
};
