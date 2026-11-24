import type { WorkflowGuide } from "./components/ds/unified-drop-zone.tsx";

/**
 * Each workflow's browser how-to page. The hero help row and the sample-link
 * menu both link it, so the two MUST stay on the same page. Paths are
 * published doc slugs (see `DOC_SOURCES` in `webapp/docs-routing.mjs`).
 */
const WORKFLOW_GUIDES = {
  cheats: { path: "docs/use-cheats", label: "ui.hero.cheatsGuide" },
  apply: { path: "docs/apply-rom-patches", label: "ui.hero.applyGuide" },
  weave: { path: "docs/create-bundles", label: "ui.hero.weaveGuide" },
  checksum: { path: "docs/checksum-roms-browser", label: "ui.hero.checksumGuide" },
  compress: { path: "docs/convert-roms-browser", label: "ui.hero.compressGuide" },
  create: { path: "docs/create-rom-patches", label: "ui.hero.createGuide" },
  extract: { path: "docs/extract-files-browser", label: "ui.hero.extractGuide" },
  identify: { path: "docs/identify-roms-browser", label: "ui.hero.identifyGuide" },
  ppfUndo: { path: "docs/undo-ppf-browser", label: "ui.hero.ppfUndoGuide" },
  playlist: { path: "docs/make-playlist-browser", label: "ui.hero.playlistGuide" },
  save: { path: "docs/edit-gen3-saves", label: "ui.hero.saveGuide" },
  test: { path: "docs/test-roms", label: "ui.hero.testGuide" },
  trim: { path: "docs/trim-roms-browser", label: "ui.hero.trimGuide" },
} as const satisfies Record<string, WorkflowGuide>;

/** Format-specific how-tos linked beside the Extract guide, for the search queries they answer. */
const EXTRACT_FORMAT_GUIDES = [
  { path: "docs/extract-chd", label: "ui.hero.extractChdGuide" },
  { path: "docs/convert-rvz-to-iso", label: "ui.hero.extractRvzGuide" },
  { path: "docs/extract-z3ds", label: "ui.hero.extractZ3dsGuide" },
] as const satisfies readonly WorkflowGuide[];

/** Format-specific how-tos linked beside the Compress guide. */
const COMPRESS_FORMAT_GUIDES = [
  { path: "docs/convert-to-chd", label: "ui.hero.compressChdGuide" },
  { path: "docs/convert-to-rvz", label: "ui.hero.compressRvzGuide" },
  { path: "docs/convert-to-z3ds", label: "ui.hero.compressZ3dsGuide" },
] as const satisfies readonly WorkflowGuide[];

/** Checksum troubleshooting and lookup guides linked from Checksum. */
const CHECKSUM_EXTRA_GUIDES = [
  { path: "docs/fix-checksum-errors", label: "ui.hero.fixChecksumGuide" },
  { path: "docs/search-rom-checksums", label: "ui.hero.searchChecksumGuide" },
] as const satisfies readonly WorkflowGuide[];

/** Checksum-search guide linked beside the Identify guide. */
const IDENTIFY_EXTRA_GUIDES = [
  { path: "docs/search-rom-checksums", label: "ui.hero.searchChecksumGuide" },
] as const satisfies readonly WorkflowGuide[];

/** Format, console, and troubleshooting guides linked from the Apply workflow disclosure. */
const APPLY_FORMAT_GUIDES = [
  { path: "docs/apply-bps-patch", label: "ui.hero.applyBpsGuide" },
  { path: "docs/apply-ips-patch", label: "ui.hero.applyIpsGuide" },
  { path: "docs/apply-ups-patch", label: "ui.hero.applyUpsGuide" },
  { path: "docs/apply-xdelta-patch", label: "ui.hero.applyXdeltaGuide" },
  { path: "docs/patch-gamecube-wii-games", label: "ui.hero.patchGcWiiGuide" },
  { path: "docs/patch-ps2-games", label: "ui.hero.patchPs2Guide" },
  { path: "docs/patch-3ds-roms", label: "ui.hero.patch3dsGuide" },
  { path: "docs/fix-checksum-errors", label: "ui.hero.fixChecksumGuide" },
] as const satisfies readonly WorkflowGuide[];

export {
  APPLY_FORMAT_GUIDES,
  CHECKSUM_EXTRA_GUIDES,
  COMPRESS_FORMAT_GUIDES,
  EXTRACT_FORMAT_GUIDES,
  IDENTIFY_EXTRA_GUIDES,
  WORKFLOW_GUIDES,
};
