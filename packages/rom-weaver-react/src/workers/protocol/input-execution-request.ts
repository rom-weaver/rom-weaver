type ChdExtractRequestInput = {
  chdFile?: DiscSourceInput;
  chdFilePath?: string;
  chdFileName: DiscOutputFileName;
  archiveEntryName?: string;
  archiveFileName?: string;
  outputName?: string;
  mode?: "auto" | string;
  threads?: number | string | null;
};

type RvzExtractRequestInput = {
  rvzFile?: DiscSourceInput;
  rvzFilePath?: string;
  rvzFileName: DiscOutputFileName;
  archiveEntryName?: string;
  archiveFileName?: string;
  outputName?: string;
  threads?: number | string | null;
};

type Z3dsExtractRequestInput = {
  z3dsFile?: DiscSourceInput;
  z3dsFilePath?: string;
  z3dsFileName: DiscOutputFileName;
  archiveEntryName?: string;
  archiveFileName?: string;
  outputName?: string;
  threads?: number | string | null;
};

const createChdExtractRequest = ({
  chdFile,
  chdFilePath,
  chdFileName,
  archiveEntryName,
  archiveFileName,
  outputName,
  mode,
  threads,
}: ChdExtractRequestInput) => ({
  archiveEntryName: archiveEntryName,
  archiveFileName: archiveFileName,
  chdFile: chdFile,
  chdFileName: chdFileName,
  chdFilePath: chdFilePath,
  kind: "chdman" as const,
  mode: mode,
  operation: "extract" as const,
  outputName: outputName,
  threads: threads,
});

const createRvzExtractRequest = ({
  rvzFile,
  rvzFilePath,
  rvzFileName,
  archiveEntryName,
  archiveFileName,
  outputName,
  threads,
}: RvzExtractRequestInput) => ({
  archiveEntryName: archiveEntryName,
  archiveFileName: archiveFileName,
  kind: "dolphin-rvz" as const,
  operation: "extract" as const,
  outputName: outputName,
  rvzFile: rvzFile,
  rvzFileName: rvzFileName,
  rvzFilePath: rvzFilePath,
  threads: threads,
});

const createZ3dsExtractRequest = ({
  z3dsFile,
  z3dsFilePath,
  z3dsFileName,
  archiveEntryName,
  archiveFileName,
  outputName,
  threads,
}: Z3dsExtractRequestInput) => ({
  archiveEntryName: archiveEntryName,
  archiveFileName: archiveFileName,
  kind: "azahar-z3ds" as const,
  operation: "extract" as const,
  outputName: outputName,
  threads: threads,
  z3dsFile: z3dsFile,
  z3dsFileName: z3dsFileName,
  z3dsFilePath: z3dsFilePath,
});

export { createChdExtractRequest, createRvzExtractRequest, createZ3dsExtractRequest };

type DiscSourceInput = string | ArrayBuffer | ArrayBufferView | Blob | File;

type DiscOutputFileName = string;
