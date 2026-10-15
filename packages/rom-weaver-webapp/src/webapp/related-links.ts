import type { MessageId } from "../presentation/localization/catalog.ts";
import type { WebappView } from "./webapp-state-types.ts";

/** One tool pointer: a tab to switch to, plus the beta gate it lives behind. */
type RelatedToolLink = {
  /** True for a tool that stays behind the beta-tools setting (Trim). */
  beta?: boolean;
  hintId?: MessageId;
  labelId: MessageId;
  view: WebappView;
};

/** One guide pointer: a docs slug (see `DOC_SOURCES` in docs-routing.mjs). */
type RelatedGuideLink = {
  slug: string;
};

type RelatedEntry = {
  guide?: RelatedGuideLink;
  /** Up to two tool links, rendered in order. */
  tools: RelatedToolLink[];
};

/**
 * What to point at next, keyed by `WebappView` for a workflow's result panel
 * and by docs slug for a guide's tool links. The two key spaces never collide -
 * every `WebappView` id is a bare word and every docs slug starts with
 * `docs/` or is exactly `docs`.
 */
const RELATED_LINKS: Record<string, RelatedEntry> = {
  "docs/apply-rom-patches": {
    tools: [{ labelId: "ui.related.applyTool", view: "patcher" }],
  },
  "docs/cli-trim": {
    tools: [{ beta: true, labelId: "ui.related.trimTool", view: "trim" }],
  },
  "docs/create-bundles": {
    tools: [{ labelId: "ui.home.goWeave", view: "weave" }],
  },
  "docs/create-rom-patches": {
    tools: [{ labelId: "ui.related.createTool", view: "creator" }],
  },
  "docs/fix-checksum-errors": {
    tools: [{ labelId: "ui.related.identifyTool", view: "identify" }],
  },
  "docs/test-roms": {
    tools: [{ labelId: "ui.related.testTool", view: "test" }],
  },
  "docs/checksum-roms-browser": {
    tools: [{ labelId: "ui.home.goChecksum", view: "checksum" }],
  },
  "docs/convert-roms-browser": {
    tools: [{ labelId: "ui.home.goCompress", view: "compress" }],
  },
  "docs/convert-rvz-to-iso": {
    tools: [{ labelId: "ui.home.goExtract", view: "extract" }],
  },
  "docs/convert-to-chd": {
    tools: [{ labelId: "ui.home.goCompress", view: "compress" }],
  },
  "docs/convert-to-rvz": {
    tools: [{ labelId: "ui.home.goCompress", view: "compress" }],
  },
  "docs/convert-to-z3ds": {
    tools: [{ labelId: "ui.home.goCompress", view: "compress" }],
  },
  "docs/create-game-saves-browser": {
    tools: [{ beta: true, labelId: "ui.related.saveTool", view: "save-editor" }],
  },
  "docs/edit-gen3-saves": {
    tools: [{ beta: true, labelId: "ui.related.saveTool", view: "save-editor" }],
  },
  "docs/extract-chd": {
    tools: [{ labelId: "ui.home.goExtract", view: "extract" }],
  },
  "docs/extract-files-browser": {
    tools: [{ labelId: "ui.home.goExtract", view: "extract" }],
  },
  "docs/extract-z3ds": {
    tools: [{ labelId: "ui.home.goExtract", view: "extract" }],
  },
  "docs/get-started": {
    tools: [{ labelId: "ui.related.applyTool", view: "patcher" }],
  },
  "docs/identify-roms-browser": {
    tools: [{ labelId: "ui.related.identifyTool", view: "identify" }],
  },
  "docs/patch-compressed-disc": {
    tools: [{ labelId: "ui.related.applyTool", view: "patcher" }],
  },
  "docs/search-rom-checksums": {
    tools: [{ labelId: "ui.related.identifyTool", view: "identify" }],
  },
  "docs/trim-roms-browser": {
    tools: [{ beta: true, labelId: "ui.related.trimTool", view: "trim" }],
  },
  "docs/undo-ppf-browser": {
    tools: [{ labelId: "ui.related.undoTool", view: "ppf-undo" }],
  },
  "docs/use-cheats": {
    tools: [
      { labelId: "ui.related.applyTool", view: "patcher" },
      { labelId: "ui.related.createTool", view: "creator" },
    ],
  },
  "not-found": {
    guide: { slug: "docs" },
    tools: [
      { labelId: "ui.related.applyTool", view: "patcher" },
      { labelId: "ui.related.testTool", view: "test" },
    ],
  },
  identify: {
    tools: [
      {
        hintId: "ui.related.hintCarriesSelection",
        labelId: "ui.related.useRomInApply",
        view: "patcher",
      },
    ],
  },
};

export { RELATED_LINKS };
