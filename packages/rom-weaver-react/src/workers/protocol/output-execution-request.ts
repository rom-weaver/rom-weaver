import type { ArchiveEntryInput, JsonValue } from "../../types/runtime.ts";
import type { ChdCompressionCodecs, CompressionOptionValue } from "../../types/workflow-compression.ts";
import type { BinaryPayload } from "../../types/workflow-source.ts";

type ChdCreateRequestInput = {
  imageFile?: BinaryPayload;
  imageFilePath?: string;
  inputFileName: string;
  outputName: string;
  chdSourceMode?: string | null;
  chdCueText?: string;
  cueInputFileName?: string;
  imageFiles?: Array<{ file?: BinaryPayload; fileName?: string; filePath?: string }>;
  chdCreateMode?: "auto" | string | null;
  chdCompressionCodecs?: ChdCompressionCodecs | null;
  threads?: number | string | null;
};

type RvzCreateRequestInput = {
  imageFile?: BinaryPayload;
  imageFilePath?: string;
  inputFileName: string;
  outputName: string;
  rvzSourceFileName?: string;
  rvzMode?: string;
  threads?: number | string | null;
  rvzOptions?: Record<string, CompressionOptionValue> | null;
};

type ArchiveCreateRequestInput = {
  entries: ArchiveEntryInput[];
  outputName: string;
  compression: string;
  codec?: string;
  level?: string | number | null;
  threads?: number | string | null;
};

type Z3dsCreateRequestInput = {
  imageFile?: BinaryPayload;
  imageFilePath?: string;
  inputFileName: string;
  outputName: string;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
  z3dsMetadata?: JsonValue;
  threads?: number | string | null;
  z3dsOptions?: Record<string, CompressionOptionValue> | null;
};

const createChdCreateRequest = ({
  imageFile,
  imageFilePath,
  inputFileName,
  outputName,
  chdSourceMode,
  chdCueText,
  cueInputFileName,
  imageFiles,
  chdCreateMode,
  chdCompressionCodecs,
  threads,
}: ChdCreateRequestInput) => ({
  chdCueText: chdCueText,
  chdMode: chdSourceMode,
  compressionCodecs: chdCompressionCodecs,
  cueInputFileName: cueInputFileName,
  fileName: inputFileName,
  imageFile: imageFile,
  imageFilePath: imageFilePath,
  imageFiles: imageFiles,
  kind: "chdman" as const,
  mode: chdCreateMode,
  operation: "create" as const,
  outputName: outputName,
  threads: threads,
});

const createRvzCreateRequest = ({
  imageFile,
  imageFilePath,
  inputFileName,
  outputName,
  rvzSourceFileName,
  rvzMode,
  threads,
  rvzOptions,
}: RvzCreateRequestInput) => ({
  fileName: inputFileName,
  imageFile: imageFile,
  imageFilePath: imageFilePath,
  kind: "dolphin-rvz" as const,
  operation: "create" as const,
  outputName: outputName,
  rvzMode: rvzMode,
  rvzSourceFileName: rvzSourceFileName,
  threads: threads,
  ...(rvzOptions || {}),
});

const createArchiveCreateRequest = ({
  entries,
  outputName,
  compression,
  codec,
  level,
  threads,
}: ArchiveCreateRequestInput) => ({
  codec: codec,
  compression: compression,
  entries: entries,
  kind: "7zip-zstd" as const,
  level: level,
  operation: "create" as const,
  outputName: outputName,
  threads: threads,
});

const createZ3dsCreateRequest = ({
  imageFile,
  imageFilePath,
  inputFileName,
  outputName,
  z3dsSourceFileName,
  z3dsUnderlyingMagic,
  z3dsMetadata,
  threads,
  z3dsOptions,
}: Z3dsCreateRequestInput) => ({
  fileName: inputFileName,
  imageFile: imageFile,
  imageFilePath: imageFilePath,
  kind: "azahar-z3ds" as const,
  operation: "create" as const,
  outputName: outputName,
  threads: threads,
  z3dsMetadata: z3dsMetadata,
  z3dsSourceFileName: z3dsSourceFileName,
  z3dsUnderlyingMagic: z3dsUnderlyingMagic,
  ...(z3dsOptions || {}),
});

export { createArchiveCreateRequest, createChdCreateRequest, createRvzCreateRequest, createZ3dsCreateRequest };
