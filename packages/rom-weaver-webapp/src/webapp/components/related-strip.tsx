import { useRomWeaverSettings, useUiLocalizer } from "../../public/react/settings-context.tsx";
import { DOC_SOURCES } from "../docs-routing.mjs";
import { RELATED_LINKS } from "../related-links.ts";

type RelatedStripProps = {
  /** A `WebappView` id (workflow result) or a docs slug (guide footer). */
  entryKey: string;
  /** The same handler the nav uses to switch tabs; never resolved here. */
  onSelectTab: (id: string) => void;
};

/**
 * "What's next" strip: up to two tool rows and one guide row. Tool rows switch
 * the app's own tab through `onSelectTab`; guide rows are plain links so the
 * document-level soft-navigation listener (see `webapp.ts`) picks them up.
 */
const RelatedStrip = ({ entryKey, onSelectTab }: RelatedStripProps) => {
  const localizer = useUiLocalizer();
  const settings = useRomWeaverSettings();
  const betaToolsEnabled = (settings as { betaToolsEnabled?: boolean }).betaToolsEnabled !== false;
  const entry = RELATED_LINKS[entryKey];
  const tools = (entry?.tools ?? []).filter((tool) => betaToolsEnabled || !tool.beta);
  const guideRoute = entry?.guide ? DOC_SOURCES.find((route) => route.slug === entry.guide?.slug) : undefined;
  if (tools.length === 0 && !guideRoute) return null;
  return (
    <nav aria-label={localizer.message("ui.related.heading")} className="related-strip">
      <ul>
        {tools.map((tool) => (
          <li key={tool.view}>
            <button className="related-row related-row-tool" onClick={() => onSelectTab(tool.view)} type="button">
              <span className="related-kind mono">{localizer.message("ui.related.kindTool")}</span>
              <span className="related-label">{localizer.message(tool.labelId)}</span>
              <span className="related-hint">{localizer.message("ui.related.hintTool")}</span>
            </button>
          </li>
        ))}
        {guideRoute ? (
          <li>
            <a className="related-row related-row-guide" href={`/${guideRoute.slug}`}>
              <span className="related-kind mono">{localizer.message("ui.related.kindGuide")}</span>
              <span className="related-label">{guideRoute.label}</span>
              <span className="related-hint">{localizer.message("ui.related.hintGuide")}</span>
            </a>
          </li>
        ) : null}
      </ul>
    </nav>
  );
};

export { RelatedStrip };
