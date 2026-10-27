import { useState } from "react";
import { isLargeEntry, useEmulatorSession } from "../../public/react/emulator-session-store.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { BannerDismissButton, Reveal } from "./shell.tsx";

/** Warns outside the Test tab that the disc-sized game paused there closes once another action starts. */
const PausedGameBanner = ({ active, onOpenTest }: { active: boolean; onOpenTest: () => void }) => {
  const localizer = useUiLocalizer();
  const { entries } = useEmulatorSession();
  const [dismissedId, setDismissedId] = useState<string>();
  const game = entries.find(isLargeEntry);
  return (
    <Reveal open={active && !!game && game.id !== dismissedId}>
      {game ? (
        <div className="updates paused-game-banner" data-testid="rom-weaver-paused-game-banner" role="status">
          <span className="updates-text">
            <b>{localizer.message("ui.pausedGame.title", { fileName: game.fileName })}</b>{" "}
            {localizer.message("ui.pausedGame.detail")}
          </span>
          <button className="btn slim" onClick={onOpenTest} type="button">
            {localizer.message("ui.pausedGame.open")}
          </button>
          <BannerDismissButton
            label={localizer.message("ui.common.dismiss")}
            onDismiss={() => setDismissedId(game.id)}
          />
        </div>
      ) : null}
    </Reveal>
  );
};

export { PausedGameBanner };
