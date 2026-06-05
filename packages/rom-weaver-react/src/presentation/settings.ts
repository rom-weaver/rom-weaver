import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";

const SETTINGS_MESSAGE_KEYS = [
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "compression",
  "compressionProfile",
  "erudaDevTools",
  "fixChecksum",
  "language",
  "logLevel",
  "requireInputChecksumMatch",
  "requireOutputChecksumMatch",
  "rvzBlockSize",
  "rvzCompression",
  "rvzCompressionLevel",
  "sevenZipCodec",
  "sevenZipLevel",
  "workerThreads",
  "z3dsCompressionLevel",
  "zipCodec",
  "zipLevel",
] as const;

const getSettingsLabel = (key: string, localizer: Localizer = createLocalizer()): string =>
  localizer.message(`settings.${key}` as MessageId);

export { getSettingsLabel, SETTINGS_MESSAGE_KEYS };
