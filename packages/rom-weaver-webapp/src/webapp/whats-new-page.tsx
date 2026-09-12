import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { ChangelogPanel } from "./components/changelog-panel.tsx";

type WhatsNewPageProps = {
  active: boolean;
  /** Reloads into the waiting deploy; only offered while one is waiting. */
  onReload?: () => void;
  updateReady?: boolean;
};

/**
 * The update banner, version chip, and More menu share this changelog route.
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
