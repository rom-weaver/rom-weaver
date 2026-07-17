import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { MessageId } from "./catalog.ts";

/**
 * English source-of-truth message descriptors keyed by stable MessageId. This
 * is the catalog devs edit to add/change UI text. `lingui extract` reads these
 * `msg(...)` calls via static analysis to build the en/es/de `.po` catalogs.
 *
 * This module is intentionally NOT imported by app code - it carries the
 * `@lingui/core/macro` import, which only resolves under the Babel macro
 * transform. The runtime instead reads the `lingui compile`d output via
 * `MESSAGE_CATALOGS` in `./catalog.ts`. Plural ids carry an ICU
 * `{count, plural, ...}` message (the legacy `.one`/`.other` pairs collapsed
 * during migration); the runtime passes `{ count }`.
 */
const MESSAGES: Record<MessageId, MessageDescriptor> = {
  "candidate.warningCount": msg({ id: "candidate.warningCount", message: "{count} warning(s)" }),
  "error.AMBIGUOUS_SELECTION": msg({ id: "error.AMBIGUOUS_SELECTION", message: "Multiple matching files were found." }),
  "error.CANCELLED": msg({ id: "error.CANCELLED", message: "Workflow was cancelled." }),
  "error.CHECKSUM_MISMATCH": msg({ id: "error.CHECKSUM_MISMATCH", message: "Checksum validation failed." }),
  "error.COMPRESSION_FAILED": msg({ id: "error.COMPRESSION_FAILED", message: "Compression failed." }),
  "error.INVALID_INPUT": msg({ id: "error.INVALID_INPUT", message: "The selected input is not valid." }),
  "error.INVALID_SETTINGS": msg({ id: "error.INVALID_SETTINGS", message: "The selected settings are not valid." }),
  "error.NO_COMPATIBLE_PATCH": msg({ id: "error.NO_COMPATIBLE_PATCH", message: "No compatible patch was found." }),
  "error.NO_SELECTABLE_CANDIDATE": msg({
    id: "error.NO_SELECTABLE_CANDIDATE",
    message: "No selectable file was found.",
  }),
  "error.OUTPUT_WRITE_FAILED": msg({ id: "error.OUTPUT_WRITE_FAILED", message: "Output could not be written." }),
  "error.PATCH_APPLY_FAILED": msg({ id: "error.PATCH_APPLY_FAILED", message: "Weaving the patch failed." }),
  "error.PATCH_CREATE_FAILED": msg({ id: "error.PATCH_CREATE_FAILED", message: "Patch creation failed." }),
  "error.PATCH_PARSE_FAILED": msg({ id: "error.PATCH_PARSE_FAILED", message: "Patch parsing failed." }),
  "error.PATCH_TARGET_MISMATCH": msg({
    id: "error.PATCH_TARGET_MISMATCH",
    message: "The patch target did not match the selected input.",
  }),
  "error.SELECTION_NOT_FOUND": msg({ id: "error.SELECTION_NOT_FOUND", message: "The selected file was not found." }),
  "error.SOURCE_NOT_FOUND": msg({ id: "error.SOURCE_NOT_FOUND", message: "The selected source could not be found." }),
  "error.SOURCE_UNSUPPORTED": msg({
    id: "error.SOURCE_UNSUPPORTED",
    message: "The selected source type is not supported.",
  }),
  "error.STORAGE_UNAVAILABLE": msg({ id: "error.STORAGE_UNAVAILABLE", message: "Storage is unavailable." }),
  "error.UNSUPPORTED_FORMAT": msg({
    id: "error.UNSUPPORTED_FORMAT",
    message: "The selected file format is not supported.",
  }),
  "error.WORKER_FAILED": msg({ id: "error.WORKER_FAILED", message: "Worker execution failed." }),
  "error.WORKER_UNAVAILABLE": msg({
    id: "error.WORKER_UNAVAILABLE",
    message: "Required worker support is unavailable.",
  }),
  "settings.betaToolsEnabled": msg({ id: "settings.betaToolsEnabled", message: "Enable beta tools (Trim and Tools)" }),
  "settings.chdCreateCdCodecs": msg({ id: "settings.chdCreateCdCodecs", message: "CD Codecs" }),
  "settings.chdCreateDvdCodecs": msg({ id: "settings.chdCreateDvdCodecs", message: "DVD Codecs" }),
  "settings.compressionProfile": msg({ id: "settings.compressionProfile", message: "Level" }),
  "settings.fixChecksum": msg({ id: "settings.fixChecksum", message: "Fix ROM header" }),
  "settings.language": msg({ id: "settings.language", message: "Language" }),
  "settings.levelOverride": msg({ id: "settings.levelOverride", message: "Level override" }),
  "settings.logLevel": msg({ id: "settings.logLevel", message: "Log level" }),
  "settings.requireInputChecksumMatch": msg({
    id: "settings.requireInputChecksumMatch",
    message: "Require input checksum match",
  }),
  "settings.rvzBlockSize": msg({ id: "settings.rvzBlockSize", message: "RVZ block size" }),
  "settings.rvzCodec": msg({ id: "settings.rvzCodec", message: "RVZ codec" }),
  "settings.sevenZipCodec": msg({ id: "settings.sevenZipCodec", message: "7z codec" }),
  "settings.workerThreads": msg({ id: "settings.workerThreads", message: "Threads" }),
  "settings.zipCodec": msg({ id: "settings.zipCodec", message: "ZIP codec" }),
  "ui.bundleExport.create": msg({ id: "ui.bundleExport.create", message: "Create {format} Bundle" }),
  "ui.bundleExport.createRom": msg({ id: "ui.bundleExport.createRom", message: "Create {format} ROM Bundle" }),
  "ui.bundleExport.download": msg({ id: "ui.bundleExport.download", message: "Download {format} Bundle" }),
  "ui.bundleExport.downloadRom": msg({ id: "ui.bundleExport.downloadRom", message: "Download {format} ROM Bundle" }),
  "ui.common.close": msg({ id: "ui.common.close", message: "Close" }),
  "ui.common.copy": msg({ id: "ui.common.copy", message: "Copy" }),
  "ui.common.dismiss": msg({ id: "ui.common.dismiss", message: "Dismiss" }),
  "ui.common.retry": msg({ id: "ui.common.retry", message: "Retry" }),
  "ui.drop.release": msg({ id: "ui.drop.release", message: "Release to add files" }),
  "ui.drop.staging": msg({ id: "ui.drop.staging", message: "Reading dropped files…" }),
  "ui.drop.tap": msg({ id: "ui.drop.tap", message: "Tap to choose files" }),
  "ui.env.threads": msg({ id: "ui.env.threads", message: "threads" }),
  "ui.footer.donate": msg({ id: "ui.footer.donate", message: "Donate" }),
  "ui.hero.accent": msg({ id: "ui.hero.accent", message: "at native speed" }),
  "ui.hero.createThesis": msg({
    id: "ui.hero.createThesis",
    message: "Compare an original ROM against a modified one,",
  }),
  "ui.hero.createThesis2": msg({ id: "ui.hero.createThesis2", message: "and produce a sharable patch —" }),
  "ui.hero.local": msg({
    id: "ui.hero.local",
    message: "All local, in your browser — files never leave your machine.",
  }),
  "ui.hero.thesis": msg({ id: "ui.hero.thesis", message: "Weave patches into any ROM or a sharable patch bundle," }),
  "ui.hero.thesis2": msg({ id: "ui.hero.thesis2", message: "and compress the result —" }),
  "ui.hero.toolsThesis": msg({
    id: "ui.hero.toolsThesis",
    message: "Revert a patched ROM to its original dump,",
  }),
  "ui.hero.toolsThesis2": msg({ id: "ui.hero.toolsThesis2", message: "using the patch's own undo data —" }),
  "ui.hero.trimThesis": msg({
    id: "ui.hero.trimThesis",
    message: "Strip padding and junk blocks from ROM dumps,",
  }),
  "ui.hero.trimThesis2": msg({ id: "ui.hero.trimThesis2", message: "and shrink them for storage —" }),
  "ui.log.emptyFilter": msg({ id: "ui.log.emptyFilter", message: "No lines match “{q}”" }),
  "ui.log.filter": msg({ id: "ui.log.filter", message: "Filter" }),
  "ui.log.filterLabel": msg({ id: "ui.log.filterLabel", message: "Filter log" }),
  "ui.log.viewCurrent": msg({ id: "ui.log.viewCurrent", message: "Current" }),
  "ui.log.viewLabel": msg({ id: "ui.log.viewLabel", message: "Shown log" }),
  "ui.log.viewPrevious": msg({ id: "ui.log.viewPrevious", message: "Previous" }),
  "ui.patch.offCount": msg({
    id: "ui.patch.offCount",
    message:
      "{count, plural, one {# patch is off - tick it to include it} other {# patches are off - tick them to include them}}",
  }),
  "ui.result.download": msg({ id: "ui.result.download", message: "Download" }),
  "ui.settings.chdCd": msg({ id: "ui.settings.chdCd", message: "CD" }),
  "ui.settings.chdDvd": msg({ id: "ui.settings.chdDvd", message: "DVD" }),
  "ui.settings.reset": msg({ id: "ui.settings.reset", message: "Reset" }),
  "ui.settings.rvzBlockSize": msg({ id: "ui.settings.rvzBlockSize", message: "Block size" }),
  "ui.settings.rvzCodec": msg({ id: "ui.settings.rvzCodec", message: "RVZ" }),
  "ui.settings.sevenZipCodec": msg({ id: "ui.settings.sevenZipCodec", message: "7z" }),
  "ui.settings.title": msg({ id: "ui.settings.title", message: "Settings" }),
  "ui.settings.zipCodec": msg({ id: "ui.settings.zipCodec", message: "ZIP" }),
  "ui.status.doneMsg": msg({ id: "ui.status.doneMsg", message: "rom-weaver finished in {t}" }),
  "ui.step.apply": msg({ id: "ui.step.apply", message: "Weave" }),
  "ui.step.modified": msg({ id: "ui.step.modified", message: "Modified" }),
  "ui.step.original": msg({ id: "ui.step.original", message: "Original" }),
  "ui.step.output": msg({ id: "ui.step.output", message: "Output" }),
  "ui.step.patches": msg({ id: "ui.step.patches", message: "Patches" }),
  "ui.step.rom": msg({ id: "ui.step.rom", message: "ROM" }),
  "ui.theme.toDark": msg({ id: "ui.theme.toDark", message: "Switch to dark theme" }),
  "ui.theme.toLight": msg({ id: "ui.theme.toLight", message: "Switch to light theme" }),
  "ui.tools.log": msg({ id: "ui.tools.log", message: "Log" }),
  "ui.tools.theme": msg({ id: "ui.tools.theme", message: "Theme" }),
  "ui.update.later": msg({ id: "ui.update.later", message: "Later" }),
  "ui.update.note": msg({
    id: "ui.update.note",
    message: "Reloading swaps the cached app. Running jobs are finished first.",
  }),
  "ui.update.ready": msg({ id: "ui.update.ready", message: "Update ready" }),
  "ui.update.reload": msg({ id: "ui.update.reload", message: "Reload" }),
  "ui.update.reloadNow": msg({ id: "ui.update.reloadNow", message: "Reload now" }),
  "ui.update.whatsNew": msg({ id: "ui.update.whatsNew", message: "What’s new" }),
  "ui.urlSession.corsHint": msg({
    id: "ui.urlSession.corsHint",
    message: "The file host must allow cross-origin downloads (CORS).",
  }),
  "ui.urlSession.error": msg({ id: "ui.urlSession.error", message: "Shared session download failed" }),
  "ui.urlSession.loading": msg({ id: "ui.urlSession.loading", message: "Loading shared session…" }),
  "ui.wakelock.text": msg({ id: "ui.wakelock.text", message: "Screen stays awake while a job is running." }),
};

export { MESSAGES };
