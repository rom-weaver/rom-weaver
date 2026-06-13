import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";

const SETTINGS_MESSAGE_KEYS = [
  "chdCreateCdCodecs",
  "chdCreateDvdCodecs",
  "compression",
  "compressionProfile",
  "fixChecksum",
  "language",
  "logLevel",
  "devTools",
  "requireInputChecksumMatch",
  "requireOutputChecksumMatch",
  "rvzBlockSize",
  "rvzCodec",
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

// Short, section-aware label used inside the grouped settings panel where the
// section header (e.g. "Codecs"/"RVZ") already supplies the redundant context.
const getUiSettingsLabel = (key: string, localizer: Localizer = createLocalizer()): string =>
  localizer.message(`ui.settings.${key}` as MessageId);

export { getSettingsLabel, getUiSettingsLabel, SETTINGS_MESSAGE_KEYS };
