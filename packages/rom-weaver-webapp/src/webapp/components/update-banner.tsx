import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_VERSION } from "../build-version.ts";
import { isNewerVersion, recordReloadingInto } from "../last-seen-version.ts";
import { fetchChangelog, HIGHLIGHTS_TITLE, type ReleaseChangelog } from "./changelog-source.tsx";
import { BannerDismissButton, Reveal } from "./shell.tsx";

/**
 * The last-resort prompt for a deploy waiting to load. It leads with one
 * highlight and leaves the rest to What's new.
 */

const logger = createLogger("update-banner");
const READY_CHANGELOG_REFRESH_INTERVAL_MS = 60_000;

// The banner has room for one line of news: the first highlight of the newest
// release it covers. Releases without highlights are passed over.
const leadHighlight = (release: ReleaseChangelog | undefined, covers: (version: string) => boolean): string => {
  for (const note of release?.notes ?? []) {
    if (!covers(note.version)) continue;
    const summary = note.groups.find((group) => group.title === HIGHLIGHTS_TITLE)?.entries[0]?.summary;
    if (summary) return summary;
  }
  return "";
};

const UpdateBannerView = ({
  highlight,
  onDismiss,
  onOpenWhatsNew,
  onReload,
  open,
  title,
}: {
  highlight: string;
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
  onReload: () => void;
  open: boolean;
  title: string;
}) => {
  const localizer = useUiLocalizer();
  return (
    <Reveal open={open}>
      <div className="updates update-banner update-ready" role="status">
        <div className="update-banner-body">
          <b className="update-banner-title">{title}</b>
          {highlight ? <p className="update-banner-highlight">{highlight}</p> : null}
        </div>
        <div className="update-banner-actions">
          <button className="btn slim" onClick={onOpenWhatsNew} type="button">
            {localizer.message("ui.update.seeWhatsNew")}
          </button>
          <button className="btn slim primary" onClick={onReload} type="button">
            {localizer.message("ui.update.reload")}
          </button>
        </div>
        <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
      </div>
    </Reveal>
  );
};

const UpdateBanner = ({
  hasUnreadUpdate,
  onDismiss,
  onOpenWhatsNew,
  onReload,
  open,
}: {
  /** Whether the visitor has not yet opened What's new for the update this page already runs. */
  hasUnreadUpdate: boolean;
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
  onReload: () => void;
  /** Whether a deploy is waiting; false closes the banner. */
  open: boolean;
}) => {
  const localizer = useUiLocalizer();
  // The snapshot keeps the closing banner's words steady while it slides away.
  const [loaded, setLoaded] = useState<{ release?: ReleaseChangelog } | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    let hasLoaded = false;
    let requestId = 0;
    // A response slower than the refresh interval still lands; only one older
    // than the changelog already shown is dropped.
    let appliedRequest = 0;
    const refresh = () => {
      const currentRequest = ++requestId;
      fetchChangelog()
        .then(({ release }) => {
          if (!current || currentRequest < appliedRequest) return;
          appliedRequest = currentRequest;
          hasLoaded = true;
          setLoaded({ release });
        })
        .catch((error) => {
          if (!current || currentRequest < appliedRequest) return;
          // The banner still says an update is ready; only the highlight is lost.
          logger.debug("Update banner changelog unavailable", { message: String(error) });
          if (!hasLoaded) {
            hasLoaded = true;
            setLoaded({});
          }
        });
    };
    refresh();
    // A later deploy can replace the waiting worker while the banner is open.
    // Refresh so the banner follows its new changelog.
    const interval = window.setInterval(refresh, READY_CHANGELOG_REFRESH_INTERVAL_MS);
    return () => {
      current = false;
      window.clearInterval(interval);
    };
  }, [open]);
  if (!loaded) return null;

  const { release } = loaded;
  const incoming = release && isNewerVersion(release.version, APP_VERSION) ? release.version : undefined;
  const reload = () => {
    // Someone up to date has just read this news, so the reload needs no
    // announcement. An unread update keeps its own.
    if (incoming && !hasUnreadUpdate) recordReloadingInto(incoming);
    onReload();
  };
  return (
    <UpdateBannerView
      highlight={
        incoming
          ? leadHighlight(
              release,
              (version) => isNewerVersion(version, APP_VERSION) && !isNewerVersion(version, incoming),
            )
          : ""
      }
      onDismiss={onDismiss}
      onOpenWhatsNew={onOpenWhatsNew}
      onReload={reload}
      open={open}
      title={
        incoming
          ? localizer.message("ui.update.readyVersion", { version: incoming })
          : localizer.message("ui.update.ready")
      }
    />
  );
};

export { UpdateBanner, UpdateBannerView };
