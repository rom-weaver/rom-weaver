import type {
  ROM_WEAVER_COMPRESSION_METADATA,
  ROM_WEAVER_CREATE_CONTAINER_FORMATS,
} from "rom-weaver-wasm/format-metadata";

type PatchFormat = "aps" | "bdf" | "bps" | "ebp" | "ips" | "pmsr" | "ppf" | "rup" | "ups" | "vcdiff" | "xdelta";

type CompressionFormat = (typeof ROM_WEAVER_CREATE_CONTAINER_FORMATS)[number] | "none";

type DefaultCompression = "auto" | "7z/special" | "zip/special" | "special only" | "7z only" | "zip only" | "none";

type CompressionProfile = (typeof ROM_WEAVER_COMPRESSION_METADATA)["profiles"][number]["name"];

type ZipCodec = (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["zipCodec"]["codecs"][number];

type SevenZipCodec = (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["sevenZipCodec"]["codecs"][number];

type StringNumber = number | string;

type WorkerSettings = {
  threads?: StringNumber | "auto";
};

type StorageSettings = {
  prefer?: "auto" | "blob" | "file" | "opfs";
  tempDirectory?: string;
};

type DecompressionLimits = {
  allowEncryptedArchives?: boolean;
  allowSymlinks?: boolean;
  maxArchiveDepth?: number;
  maxCandidateEntries?: number;
  maxEntries?: number;
  maxOutputBytes?: number;
  maxSingleFileBytes?: number;
  maxTotalUncompressedBytes?: number;
};

type LoggingSettings = {
  level?: import("./logging.ts").LogLevel;
  sink?: import("./logging.ts").LogSink;
};

type CommonSettings = {
  defaultCompression?: DefaultCompression;
  input?: InputSettings;
  limits?: DecompressionLimits;
  logging?: LoggingSettings;
  storage?: StorageSettings;
  workers?: WorkerSettings;
};

type InputSettings = {
  chdSplitBin?: boolean;
  containerInputsEnabled?: boolean;
};

type PatchValidationSettings = {
  requireInputChecksumMatch?: boolean;
  requireOutputChecksumMatch?: boolean;
};

type PatchTransformSettings = {
  addHeader?: boolean;
  fixChecksum?: boolean;
  appendOutputSuffix?: boolean;
  removeHeader?: boolean;
};

type CompressionSettings = {
  chdCreateCdCodecs?: string;
  chdCreateDvdCodecs?: string;
  chdOutputMode?: "auto" | "cd" | "dvd" | string;
  format?: "auto" | CompressionFormat;
  profile?: CompressionProfile;
  rvzBlockSize?: StringNumber;
  rvzCodec?: string;
  rvzCompressionLevel?: StringNumber;
  rvzScrub?: boolean | string | number;
  sevenZipCodec?: SevenZipCodec;
  sevenZipLevel?: StringNumber;
  workerThreads?: StringNumber;
  z3dsCompressionLevel?: StringNumber | "default";
  zipCodec?: ZipCodec;
  zipLevel?: StringNumber;
};

type OutputSettings = {
  container?: Omit<CompressionSettings, "format" | "workerThreads">;
  compression?: "auto" | CompressionFormat;
  extension?: string;
  outputName?: string;
  suffix?: boolean;
};

type ApplySettings = CommonSettings & {
  compatibility?: PatchTransformSettings;
  output?: OutputSettings;
  validation?: PatchValidationSettings;
};

type CreateSettings = CommonSettings & {
  format?: PatchFormat;
  output?: Pick<OutputSettings, "container" | "compression" | "outputName">;
  patch?: {
    metadata?: Record<string, unknown>;
  };
};

export type {
  ApplySettings,
  CommonSettings,
  CompressionFormat,
  CompressionProfile,
  CompressionSettings,
  CreateSettings,
  DecompressionLimits,
  DefaultCompression,
  InputSettings,
  LoggingSettings,
  OutputSettings,
  PatchFormat,
  PatchTransformSettings,
  PatchValidationSettings,
  SevenZipCodec,
  StorageSettings,
  StringNumber,
  WorkerSettings,
  ZipCodec,
};
