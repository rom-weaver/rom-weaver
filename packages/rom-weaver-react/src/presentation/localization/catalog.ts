import type { WorkflowProgressStage } from "../../types/progress.ts";

type LocaleCode = string;

type MessageId =
  | `candidate.${string}`
  | `error.${string}`
  | `output.${string}`
  | `progress.${WorkflowProgressStage}`
  | `settings.${string}`;

type MessageCatalog = Record<MessageId, string>;

const ENGLISH_MESSAGES = {
  "candidate.ambiguous": "Choose which {role} to use from {sourceName}.",
  "candidate.file": "file",
  "candidate.group": "group {kind}",
  "candidate.rerun": "Rerun with {optionName} <id>.",
  "candidate.selectable": "Selectable {role} files:",
  "candidate.warningCount": "{count} warning(s)",
  "error.AMBIGUOUS_SELECTION": "Multiple matching files were found.",
  "error.CANCELLED": "Workflow was cancelled.",
  "error.CHECKSUM_MISMATCH": "Checksum validation failed.",
  "error.COMPRESSION_FAILED": "Compression failed.",
  "error.INVALID_INPUT": "The selected input is not valid.",
  "error.INVALID_SETTINGS": "The selected settings are not valid.",
  "error.NO_COMPATIBLE_PATCH": "No compatible patch was found.",
  "error.NO_SELECTABLE_CANDIDATE": "No selectable file was found.",
  "error.OUTPUT_WRITE_FAILED": "Output could not be written.",
  "error.PATCH_APPLY_FAILED": "Patch application failed.",
  "error.PATCH_CREATE_FAILED": "Patch creation failed.",
  "error.PATCH_PARSE_FAILED": "Patch parsing failed.",
  "error.PATCH_TARGET_MISMATCH": "The patch target did not match the selected input.",
  "error.SELECTION_NOT_FOUND": "The selected file was not found.",
  "error.SOURCE_NOT_FOUND": "The selected source could not be found.",
  "error.SOURCE_UNSUPPORTED": "The selected source type is not supported.",
  "error.STORAGE_UNAVAILABLE": "Storage is unavailable.",
  "error.UNSUPPORTED_FORMAT": "The selected file format is not supported.",
  "error.WORKER_FAILED": "Worker execution failed.",
  "error.WORKER_UNAVAILABLE": "Required worker support is unavailable.",
  "output.created": "Created {fileName}",
  "output.saved": "successfully saved to {path}",
  "output.sizeChange": "{percent} {direction}",
  "output.sizeRatio": "{percent} of raw",
  "progress.apply": "Applying patch",
  "progress.checksum": "Checking checksum",
  "progress.compress": "Compressing output",
  "progress.create": "Creating patch",
  "progress.decompress": "Decompressing input",
  "progress.detect": "Detecting files",
  "progress.parse": "Parsing patch",
  "progress.select": "Selecting file",
  "progress.trim": "Trimming ROM",
  "progress.verify": "Verifying output",
  "progress.write": "Writing output",
  "settings.chdCreateCdCodecs": "Create CD codecs",
  "settings.chdCreateDvdCodecs": "Create DVD codecs",
  "settings.compression": "Compression",
  "settings.compressionProfile": "Level",
  "settings.erudaDevTools": "Eruda dev tools",
  "settings.fixChecksum": "Fix ROM header",
  "settings.language": "Language",
  "settings.logLevel": "Log level",
  "settings.requireInputChecksumMatch": "Require input match",
  "settings.requireOutputChecksumMatch": "Require output match",
  "settings.rvzBlockSize": "RVZ block size",
  "settings.rvzCompression": "Compression",
  "settings.rvzCompressionLevel": "Level override",
  "settings.sevenZipCodec": "Codec",
  "settings.sevenZipLevel": "Level override",
  "settings.workerThreads": "Worker threads",
  "settings.z3dsCompressionLevel": "Level override",
  "settings.zipCodec": "Codec",
  "settings.zipLevel": "Level override",
} as const satisfies MessageCatalog;

const MESSAGE_CATALOGS: Record<LocaleCode, MessageCatalog> = {
  en: ENGLISH_MESSAGES,
};

const DEFAULT_LOCALE = "en";

export type { LocaleCode, MessageCatalog, MessageId };
export { DEFAULT_LOCALE, ENGLISH_MESSAGES, MESSAGE_CATALOGS };
