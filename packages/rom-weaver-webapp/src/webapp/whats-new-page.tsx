import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { ChangelogPanel } from "./components/changelog-panel.tsx";

type WhatsNewPageProps = {
  active: boolean;
  /** Reloads into the waiting deploy; only offered while one is waiting. */
  onReload?: () => void;
  updateReady?: boolean;
};

/**
 * The What's new route: the changelog the diagnostics dialog's Changelog tab
 * used to hold, promoted to its own page so the update banner, the version
 * chip, and the More menu can each link straight to it instead of a modal tab.
 */
const WhatsNewPage = ({ active, onReload, updateReady = false }: WhatsNewPageProps) => {
  const localizer = useUiLocalizer();
  return (
    <div className="status-panel whats-new-page">
      <ChangelogPanel active={active} localizer={localizer} onReload={onReload} updateReady={updateReady} />
    </div>
  );
};

export { WhatsNewPage };
export type { WhatsNewPageProps };
