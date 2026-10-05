import { ArrowLeft } from "lucide-react";
import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { ChangelogPanel } from "./components/changelog-panel.tsx";

type WhatsNewPageProps = {
  active: boolean;
  onBack: () => void;
  /** Reloads into the waiting deploy; only offered while one is waiting. */
  onReload?: () => void;
  updateReady?: boolean;
};

/**
 * The update banner, version chip, and More menu share this changelog route.
 */
const WhatsNewPage = ({ active, onBack, onReload, updateReady = false }: WhatsNewPageProps) => {
  const localizer = useUiLocalizer();
  return (
    <div className="status-panel whats-new-page">
      <button className="btn btn-ghost" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" />
        {localizer.message("ui.tutorial.back")}
      </button>
      <h1 className="whats-new-title">{localizer.message("ui.update.whatsNew")}</h1>
      <ChangelogPanel active={active} localizer={localizer} onReload={onReload} updateReady={updateReady} />
    </div>
  );
};

export { WhatsNewPage };
export type { WhatsNewPageProps };
