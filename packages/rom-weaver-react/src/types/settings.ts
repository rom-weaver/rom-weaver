type PatchFormat = "aps" | "bdf" | "bps" | "ebp" | "ips" | "pmsr" | "ppf" | "rup" | "ups" | "vcdiff" | "xdelta";

type CompressionFormat = "7z" | "chd" | "none" | "rvz" | "z3ds" | "zip";

type DefaultCompression = "auto" | "7z/special" | "zip/special" | "special only" | "7z only" | "zip only" | "none";

type CompressionProfile = "high" | "low" | "max" | "medium" | "min" | "very-high" | "very-low";

type ZipCodec = "deflate" | "store" | "zstd";

type SevenZipCodec = "lzma2";

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
  format?: "auto" | CompressionFormat;
  profile?: CompressionProfile;
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
