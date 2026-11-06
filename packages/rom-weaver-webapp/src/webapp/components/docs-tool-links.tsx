import { ArrowRight } from "lucide-react";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { RELATED_LINKS } from "../related-links.ts";
import { appendCreatorMode, appPathHref, VIEW_TO_ROUTE_SLUG } from "../app-routes.ts";
import { useAppBaseUrl } from "../use-app-base-url.ts";

const DocsToolLinks = ({ slug }: { slug: string }) => {
  const localizer = useUiLocalizer();
  const appBaseUrl = useAppBaseUrl();
  const tools = RELATED_LINKS[slug]?.tools ?? [];
  if (tools.length === 0) return null;
  const label = localizer.message("ui.docs.tools");
  return (
    <nav aria-label={label} className="related-strip docs-tools">
      <span className="related-hint">{label}</span>
      <ul>
        {tools.map((tool) => (
          // Keep beta links in the static markup; CSS follows the boot-time setting.
          <li data-beta={tool.beta ? "true" : undefined} key={tool.view}>
            <a
              className="btn ghost docs-tool"
              href={appendCreatorMode(appPathHref(tool.entry ?? VIEW_TO_ROUTE_SLUG[tool.view], appBaseUrl), tool.mode)}
            >
              {localizer.message(tool.labelId)}
              <ArrowRight aria-hidden="true" size={14} />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};

export { DocsToolLinks };
