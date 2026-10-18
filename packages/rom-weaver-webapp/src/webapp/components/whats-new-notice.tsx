import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_VERSION } from "../build-version.ts";
import { isNewRelease, type UpdatedSince } from "../last-seen-version.ts";
import { fetchChangelog, HIGHLIGHTS_TITLE, type ReleaseChangelog } from "./changelog-source.tsx";
import { BannerDismissButton, Reveal } from "./shell.tsx";

/**
 * The banner a returning visitor sees on the first load of a newer release.
 * It leads with one highlight and leaves the rest to What's new.
 */

const logger = createLogger("whats-new-notice");

// The banner has room for one line of news: the first highlight of the newest
// release this update brought. Releases without highlights are passed over.
const leadHighlight = (release: ReleaseChangelog | undefined, since: UpdatedSince): string => {
  for (const note of release?.notes ?? []) {
    if (!isNewRelease(note.version, since)) continue;
    const summary = note.groups.find((group) => group.title === HIGHLIGHTS_TITLE)?.entries[0]?.summary;
    if (summary) return summary;
  }
  return "";
};

const WhatsNewNotice = ({
  onDismiss,
  onOpenWhatsNew,
  open,
  since,
}: {
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
  open: boolean;
  since: UpdatedSince;
}) => {
  const localizer = useUiLocalizer();
  // Null until the changelog settles, so the banner opens once at its final height.
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    fetchChangelog()
      .then(({ release }) => {
        if (current) setHighlight(leadHighlight(release, since));
      })
      .catch((error) => {
        // The notice still says what version is running; only the highlight is lost.
        logger.debug("Update notice changelog unavailable", { message: String(error) });
        if (current) setHighlight("");
      });
    return () => {
      current = false;
    };
  }, [since]);
  const title = since.from
    ? localizer.message("ui.update.updatedFrom", { from: since.from, to: APP_VERSION })
    : localizer.message("ui.update.updatedTo", { version: APP_VERSION });
  return (
    <Reveal open={open && highlight !== null}>
      <div className="updates updated-notice" role="status">
        <div className="updated-body">
          <b className="updated-title">{title}</b>
          {highlight ? <p className="updated-highlight">{highlight}</p> : null}
        </div>
        <button className="btn slim" onClick={onOpenWhatsNew} type="button">
          {localizer.message("ui.update.seeWhatsNew")}
        </button>
        <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
      </div>
    </Reveal>
  );
};

export { WhatsNewNotice };
