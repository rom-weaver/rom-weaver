import { useUiLocalizer } from "../public/react/settings-context.tsx";
import { ChangelogPanel } from "./components/changelog-panel.tsx";
import type { UpdatedSince } from "./last-seen-version.ts";

type WhatsNewPageProps = {
  active: boolean;
  /** Reloads into the waiting deploy; only offered while one is waiting. */
  onReload?: () => void;
  /** The update this page load brought a returning visitor, whose releases are marked new. */
  since?: UpdatedSince | null;
  updateReady?: boolean;
};

/**
 * The update banners, version chip, and More menu share this changelog route.
 */
const WhatsNewPage = ({ active, onReload, since = null, updateReady = false }: WhatsNewPageProps) => {
  const localizer = useUiLocalizer();
  return (
    <div className="status-panel whats-new-page">
      <h1 className="whats-new-title">{localizer.message("ui.update.whatsNew")}</h1>
      <ChangelogPanel
        active={active}
        localizer={localizer}
        onReload={onReload}
        since={since}
        updateReady={updateReady}
      />
    </div>
  );
};

export { WhatsNewPage };
export type { WhatsNewPageProps };
