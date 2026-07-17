import type { StringNumber, StringNumberBoolean } from "./runtime.ts";

type CompressionOptionValue = StringNumberBoolean | null;

type ChdCompressionCodecs = string | Record<string, CompressionOptionValue>;

type InternalCompressionSettings = {
  sevenZipCodec?: string;
  sevenZipLevel?: StringNumber;
  zipCodec?: string;
  zipLevel?: StringNumber;
};

type ArchiveOutputSettings = Pick<
  InternalCompressionSettings,
  "sevenZipCodec" | "sevenZipLevel" | "zipCodec" | "zipLevel"
>;

type CompressionIntermediateOptions = {
  chdOutputMode?: "cd" | "dvd" | "auto" | string;
};

export type { ArchiveOutputSettings, ChdCompressionCodecs, CompressionIntermediateOptions, CompressionOptionValue };
