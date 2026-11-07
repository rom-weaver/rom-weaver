import type { MessageId } from "../../presentation/localization/catalog.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { WORKFLOW_ENTRY_ROUTES } from "../workflow-seo.mjs";
import type { WebappView } from "../webapp-state-types.ts";

type AboutRouteKey = WebappView | keyof typeof WORKFLOW_ENTRY_ROUTES;

type AboutCopy = { body: readonly MessageId[]; title: MessageId };

/** Reads `ui.about.<key>Title` and `ui.about.<key>Body1` through `Body3`. */
const aboutCopy = (key: string): AboutCopy => ({
  body: [`ui.about.${key}Body1`, `ui.about.${key}Body2`, `ui.about.${key}Body3`],
  title: `ui.about.${key}Title`,
});

/**
 * Each indexed tool page's own introduction, keyed by view or by the entry
 * route it opened on, so tool pages that share a view's chrome still differ.
 */
const WORKFLOW_ABOUT: Partial<Record<AboutRouteKey, AboutCopy>> = {
  "apply-cheats": aboutCopy("applyCheats"),
  checksum: aboutCopy("checksum"),
  compress: aboutCopy("compress"),
  "create-rom-cheat-patch": aboutCopy("createCheats"),
  creator: aboutCopy("create"),
  extract: aboutCopy("extract"),
  identify: aboutCopy("identify"),
  patcher: aboutCopy("apply"),
  playlist: aboutCopy("playlist"),
  "ppf-undo": aboutCopy("ppfUndo"),
  test: aboutCopy("test"),
  trim: aboutCopy("trim"),
  weave: aboutCopy("weave"),
};

const WorkflowAbout = ({ routeKey }: { routeKey: AboutRouteKey }) => {
  const localizer = useUiLocalizer();
  const copy = WORKFLOW_ABOUT[routeKey];
  if (!copy) return null;
  return (
    <details className="hero-formats-help workflow-about">
      <summary>{localizer.message("ui.hero.howItWorks")}</summary>
      <div className="info-support">
        <h2>{localizer.message(copy.title)}</h2>
        {copy.body.map((id) => (
          <p key={id}>{localizer.message(id)}</p>
        ))}
      </div>
    </details>
  );
};

export { WorkflowAbout };
