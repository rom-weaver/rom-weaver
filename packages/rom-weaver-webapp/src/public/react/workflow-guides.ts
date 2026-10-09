import type { WorkflowGuide } from "./components/ds/unified-drop-zone.tsx";

/**
 * Each workflow's browser how-to page. The hero help row and the sample-link
 * menu both link it, so the two MUST stay on the same page. Paths are
 * published doc slugs (see `DOC_SOURCES` in `webapp/docs-routing.mjs`).
 */
const WORKFLOW_GUIDES = {
  apply: { path: "docs/apply-rom-patches", label: "ui.hero.applyGuide" },
  weave: { path: "docs/create-bundles", label: "ui.hero.weaveGuide" },
  compress: { path: "docs/convert-roms-browser", label: "ui.hero.compressGuide" },
  create: { path: "docs/create-rom-patches", label: "ui.hero.createGuide" },
  extract: { path: "docs/extract-files-browser", label: "ui.hero.extractGuide" },
  identify: { path: "docs/identify-roms-browser", label: "ui.hero.identifyGuide" },
  ppfUndo: { path: "docs/undo-ppf-browser", label: "ui.hero.ppfUndoGuide" },
  save: { path: "docs/edit-gen3-saves", label: "ui.hero.saveGuide" },
  test: { path: "docs/test-roms", label: "ui.hero.testGuide" },
  trim: { path: "docs/trim-roms-browser", label: "ui.hero.trimGuide" },
} as const satisfies Record<string, WorkflowGuide>;

export { WORKFLOW_GUIDES };
