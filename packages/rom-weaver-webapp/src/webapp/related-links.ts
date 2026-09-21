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
 * and by docs slug for a guide's footer. The two key spaces never collide -
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
    tools: [{ labelId: "ui.related.applyTool", view: "patcher" }],
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
