import {
  createChdExtractRequest,
  createRvzExtractRequest,
  createZ3dsExtractRequest,
} from "./input-execution-request.ts";
import {
  createArchiveCreateRequest,
  createChdCreateRequest,
  createRvzCreateRequest,
  createZ3dsCreateRequest,
} from "./output-execution-request.ts";
import type { CompressionWorkerKind, CompressionWorkerOperation, CompressionWorkerRequest } from "./worker-protocol.ts";

type WorkerDescriptor = {
  name: string;
  path: string;
};

type NormalizedWorkerSource = {
  filePath: string;
};

type CompressionWorkerRequestBuilderResult = Record<string, RuntimeValue>;

type CompressionWorkerDescriptor = WorkerDescriptor & {
  fallbackErrorMessage: string;
  kind: CompressionWorkerKind;
  operations: readonly CompressionWorkerOperation[];
  supportedFormats?: Partial<Record<Exclude<CompressionWorkerOperation, "cleanup" | "warmup">, readonly string[]>>;
  requestBuilders: Partial<
    Record<
      CompressionWorkerOperation,
      (input: Record<string, RuntimeValue>, source?: NormalizedWorkerSource) => CompressionWorkerRequestBuilderResult
    >
  >;
  sourcePathKeys?: Partial<Record<CompressionWorkerOperation, keyof CompressionWorkerRequest>>;
};

const FILE_EXTENSION_REGEX = /\.[^./\\\s]+$/;
const LEADING_DOTS_REGEX = /^\.+/;

const replaceFileExtension = (fileName: string, extension: string) => {
  const normalizedExtension = extension.replace(LEADING_DOTS_REGEX, "") || "bin";
  return FILE_EXTENSION_REGEX.test(fileName)
    ? fileName.replace(FILE_EXTENSION_REGEX, `.${normalizedExtension}`)
    : `${fileName}.${normalizedExtension}`;
};

const getSevenZipZstdOutputExtension = (compression: string, codec?: string) =>
  compression === "zip" && codec === "zstd" ? "zipx" : compression;

const workerDescriptors = {
  "7zip-zstd": {
    name: "rpjs-7zip-worker",
    path: "../compression-7zip-zstd/compression-7zip.worker.ts",
  },
  "azahar-z3ds": {
    name: "rpjs-z3ds-worker",
    path: "../compression-azahar-z3ds/compression-z3ds.worker.ts",
  },
  chdman: {
    name: "rpjs-chd-worker",
    path: "../compression-chdman/compression-chd.worker.ts",
  },
  checksum: {
    name: "rpjs-checksum-worker",
    path: "../patch-checksum/patch-checksum.worker.ts",
  },
  "dolphin-rvz": {
    name: "rpjs-rvz-worker",
    path: "../compression-dolphin-rvz/compression-rvz.worker.ts",
  },
  patch: {
    name: "rpjs-patch-worker",
    path: "../patch-checksum/patch-checksum.worker.ts",
  },
} as const satisfies Record<string, WorkerDescriptor>;

const createSevenZipZstdRequest = (input: Record<string, RuntimeValue>) => ({
  codec: input.codec as string | undefined,
  compression: input.compression as string | undefined,
  entries: input.entries as CompressionWorkerRequest["entries"],
  entryName: input.entryName as string | undefined,
  fileName: input.fileName as string | undefined,
  logLevel: input.logLevel as string | undefined,
  outputName: input.outputName as string | undefined,
  threads: input.threads as CompressionWorkerRequest["threads"],
});

const getDefaultSevenZipZstdOutputFileName = (input: Record<string, RuntimeValue>) => {
  const compression = String(input.compression || "7z");
  const entries = ((input.entries || []) as NonNullable<CompressionWorkerRequest["entries"]>) || [];
  const firstEntry = entries[0];
  const firstEntryFileName = firstEntry?.fileName || firstEntry?.filename || firstEntry?.name || "archive.bin";
  return replaceFileExtension(firstEntryFileName, getSevenZipZstdOutputExtension(compression, input.codec as string));
};

const compressionWorkerDescriptors: Record<CompressionWorkerKind, CompressionWorkerDescriptor> = {
  "7zip-zstd": {
    ...workerDescriptors["7zip-zstd"],
    fallbackErrorMessage: "7zip-zstd operation failed",
    kind: "7zip-zstd",
    operations: ["warmup", "list", "create", "extract", "cleanup"],
    requestBuilders: {
      create: (input) =>
        createArchiveCreateRequest({
          codec: input.codec as string | undefined,
          compression: String(input.compression || "7z"),
          entries: (input.entries || []) as NonNullable<CompressionWorkerRequest["entries"]>,
          level: input.level as string | number | null | undefined,
          outputName:
            typeof input.outputName === "string" && input.outputName.trim()
              ? input.outputName
              : getDefaultSevenZipZstdOutputFileName(input),
          threads: input.threads as CompressionWorkerRequest["threads"],
        }) as CompressionWorkerRequestBuilderResult,
      extract: (input) =>
        ({
          ...createSevenZipZstdRequest(input),
        }) as CompressionWorkerRequestBuilderResult,
      list: (input) =>
        ({
          fileName: input.fileName as string | undefined,
          logLevel: input.logLevel as string | undefined,
          threads: input.threads as CompressionWorkerRequest["threads"],
        }) as CompressionWorkerRequestBuilderResult,
    },
    sourcePathKeys: {
      extract: "filePath",
      list: "filePath",
    },
    supportedFormats: {
      create: ["7z", "zip"],
      extract: ["7z", "rar", "zip", "zipx"],
      list: ["7z", "rar", "zip", "zipx"],
    },
  },
  "azahar-z3ds": {
    ...workerDescriptors["azahar-z3ds"],
    fallbackErrorMessage: "Z3DS operation requires a worker and the worker failed to load or crashed.",
    kind: "azahar-z3ds",
    operations: ["warmup", "list", "create", "extract", "cleanup"],
    requestBuilders: {
      create: (input, source) =>
        ({
          ...createZ3dsCreateRequest({
            imageFilePath: source?.filePath,
            inputFileName: String(input.fileName || "input.bin"),
            outputName: String(input.outputName || "output.z3ds"),
            threads: input.threads as CompressionWorkerRequest["threads"],
            z3dsMetadata: input.z3dsMetadata as Parameters<typeof createZ3dsCreateRequest>[0]["z3dsMetadata"],
            z3dsOptions: input.z3dsOptions as Parameters<typeof createZ3dsCreateRequest>[0]["z3dsOptions"],
            z3dsSourceFileName: input.z3dsSourceFileName as string | undefined,
            z3dsUnderlyingMagic: input.z3dsUnderlyingMagic as string | undefined,
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      extract: (input, source) =>
        ({
          ...createZ3dsExtractRequest({
            outputName: input.outputName as string | undefined,
            threads: input.threads as CompressionWorkerRequest["threads"],
            z3dsFileName: String(input.fileName || "input.z3ds"),
            z3dsFilePath: source?.filePath,
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      list: (input, source) =>
        ({
          kind: "azahar-z3ds" as const,
          logLevel: input.logLevel as string | undefined,
          operation: "list" as const,
          threads: input.threads as CompressionWorkerRequest["threads"],
          z3dsFileName: String(input.fileName || "input.z3ds"),
          z3dsFilePath: source?.filePath,
        }) as CompressionWorkerRequestBuilderResult,
    },
    sourcePathKeys: {
      create: "imageFilePath",
      extract: "z3dsFilePath",
      list: "z3dsFilePath",
    },
    supportedFormats: {
      create: ["z3ds"],
      extract: ["z3ds"],
      list: ["z3ds"],
    },
  },
  chdman: {
    ...workerDescriptors.chdman,
    fallbackErrorMessage: "CHD operation requires a worker and the worker failed to load or crashed.",
    kind: "chdman",
    operations: ["warmup", "list", "create", "extract", "cleanup"],
    requestBuilders: {
      create: (input, source) =>
        ({
          ...createChdCreateRequest({
            chdCompressionCodecs: input.compressionCodecs as Parameters<
              typeof createChdCreateRequest
            >[0]["chdCompressionCodecs"],
            chdCreateMode: (input.mode as string | null | undefined) || "auto",
            chdCueText: (input.cueText as string | null | undefined) || undefined,
            chdSourceMode: (input.chdSourceMode as string | null | undefined) || undefined,
            imageFilePath: source?.filePath,
            inputFileName: String(input.fileName || "input.bin"),
            outputName: String(input.outputName || "output.chd"),
            threads: input.threads as CompressionWorkerRequest["threads"],
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      extract: (input, source) =>
        ({
          ...createChdExtractRequest({
            chdFileName: String(input.fileName || "input.chd"),
            chdFilePath: source?.filePath,
            mode: (input.mode as string | null | undefined) || "auto",
            outputName: input.outputName as string | undefined,
            threads: input.threads as CompressionWorkerRequest["threads"],
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      list: (input, source) =>
        ({
          chdFileName: String(input.fileName || "input.chd"),
          chdFilePath: source?.filePath,
          kind: "chdman" as const,
          logLevel: input.logLevel as string | undefined,
          mode: (input.mode as string | null | undefined) || "auto",
          operation: "list" as const,
          threads: input.threads as CompressionWorkerRequest["threads"],
        }) as CompressionWorkerRequestBuilderResult,
    },
    sourcePathKeys: {
      create: "imageFilePath",
      extract: "chdFilePath",
      list: "chdFilePath",
    },
    supportedFormats: {
      create: ["chd"],
      extract: ["chd"],
      list: ["chd"],
    },
  },
  "dolphin-rvz": {
    ...workerDescriptors["dolphin-rvz"],
    fallbackErrorMessage: "RVZ operation requires a worker and the worker failed to load or crashed.",
    kind: "dolphin-rvz",
    operations: ["warmup", "list", "create", "extract", "cleanup"],
    requestBuilders: {
      create: (input, source) =>
        ({
          ...createRvzCreateRequest({
            imageFilePath: source?.filePath,
            inputFileName: String(input.fileName || "input.iso"),
            outputName: String(input.outputName || "output.rvz"),
            rvzMode: input.rvzMode as string | undefined,
            rvzOptions: {
              ...(input.rvzBlockSize === undefined ? {} : { rvzBlockSize: input.rvzBlockSize }),
              ...(input.rvzCompression === undefined ? {} : { rvzCompression: input.rvzCompression }),
              ...(input.rvzCompressionLevel === undefined ? {} : { rvzCompressionLevel: input.rvzCompressionLevel }),
              ...(input.rvzScrub === undefined ? {} : { rvzScrub: input.rvzScrub }),
            },
            rvzSourceFileName: input.rvzSourceFileName as string | undefined,
            threads: input.threads as CompressionWorkerRequest["threads"],
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      extract: (input, source) =>
        ({
          ...createRvzExtractRequest({
            outputName: input.outputName as string | undefined,
            rvzFileName: String(input.fileName || "input.rvz"),
            rvzFilePath: source?.filePath,
            threads: input.threads as CompressionWorkerRequest["threads"],
          }),
          logLevel: input.logLevel as string | undefined,
        }) as CompressionWorkerRequestBuilderResult,
      list: (input, source) =>
        ({
          kind: "dolphin-rvz" as const,
          logLevel: input.logLevel as string | undefined,
          operation: "list" as const,
          rvzFileName: String(input.fileName || "input.rvz"),
          rvzFilePath: source?.filePath,
          threads: input.threads as CompressionWorkerRequest["threads"],
        }) as CompressionWorkerRequestBuilderResult,
    },
    sourcePathKeys: {
      create: "imageFilePath",
      extract: "rvzFilePath",
      list: "rvzFilePath",
    },
    supportedFormats: {
      create: ["rvz"],
      extract: ["rvz"],
      list: ["rvz"],
    },
  },
};

const getRegistryDescriptor = <TKind extends string, TDescriptor>(
  descriptors: Partial<Record<TKind, TDescriptor>>,
  kind: TKind,
  label: string,
) => {
  const descriptor = descriptors[kind];
  if (!descriptor) throw new Error(`Unsupported ${label}: ${kind}`);
  return descriptor;
};

const getCompressionWorkerDescriptor = (kind: CompressionWorkerKind) =>
  getRegistryDescriptor(compressionWorkerDescriptors, kind, "compression worker kind");

const getCompressionWorkerKindForFormat = (
  operation: Exclude<CompressionWorkerOperation, "cleanup" | "warmup">,
  format: string,
) => {
  const normalizedFormat = String(format || "").toLowerCase();
  for (const descriptor of Object.values(compressionWorkerDescriptors)) {
    if (descriptor.supportedFormats?.[operation]?.includes(normalizedFormat)) return descriptor.kind;
  }
  throw new Error(`Unsupported compression ${operation} format: ${normalizedFormat}`);
};

export type { CompressionWorkerDescriptor, NormalizedWorkerSource, WorkerDescriptor };
export {
  compressionWorkerDescriptors,
  getCompressionWorkerDescriptor,
  getCompressionWorkerKindForFormat,
  getRegistryDescriptor,
  workerDescriptors,
};
