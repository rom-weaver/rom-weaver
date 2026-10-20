import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_VERSION } from "../build-version.ts";
import { isNewerVersion, isNewRelease, recordReloadingInto, type UpdatedSince } from "../last-seen-version.ts";
import { fetchChangelog, HIGHLIGHTS_TITLE, type ReleaseChangelog } from "./changelog-source.tsx";
import { BannerDismissButton, Reveal } from "./shell.tsx";

/**
 * One banner for both ends of an update: a deploy waiting to load ("ready") and
 * the first load of a newer release for a returning visitor ("updated"). Each
 * leads with one highlight and leaves the rest to What's new.
 */

const logger = createLogger("update-banner");
const READY_CHANGELOG_REFRESH_INTERVAL_MS = 60_000;

type UpdateBannerKind = "ready" | "updated";

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

/** The chrome both kinds share; `onReload` is what makes it the waiting-deploy prompt. */
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
  onReload?: () => void;
  open: boolean;
  title: string;
}) => {
  const localizer = useUiLocalizer();
  return (
    <Reveal open={open}>
      <div className={onReload ? "updates update-banner update-ready" : "updates update-banner"} role="status">
        <div className="update-banner-body">
          <b className="update-banner-title">{title}</b>
          {highlight ? <p className="update-banner-highlight">{highlight}</p> : null}
        </div>
        <div className="update-banner-actions">
          <button className="btn slim" onClick={onOpenWhatsNew} type="button">
            {localizer.message("ui.update.seeWhatsNew")}
          </button>
          {onReload ? (
            <button className="btn slim primary" onClick={onReload} type="button">
              {localizer.message("ui.update.reload")}
            </button>
          ) : null}
        </div>
        <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
      </div>
    </Reveal>
  );
};

const UpdateBanner = ({
  kind,
  onDismiss,
  onOpenWhatsNew,
  onReload,
  since,
}: {
  /** Which moment to announce; null closes the banner. */
  kind: UpdateBannerKind | null;
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
  onReload: () => void;
  /** The update the visitor has not acknowledged yet, if any. */
  since: UpdatedSince | null;
}) => {
  const localizer = useUiLocalizer();
  // The snapshot keeps the closing banner's words steady while it slides away.
  const [loaded, setLoaded] = useState<{
    kind: UpdateBannerKind;
    release?: ReleaseChangelog;
    since: UpdatedSince;
  } | null>(null);
  const sinceRef = useRef(since);
  sinceRef.current = since;
  useEffect(() => {
    if (!kind) return undefined;
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
          setLoaded({ kind, release, since: sinceRef.current ?? {} });
        })
        .catch((error) => {
          if (!current || currentRequest < appliedRequest) return;
          // The banner still names the update; only the highlight is lost.
          logger.debug("Update banner changelog unavailable", { kind, message: String(error) });
          if (!hasLoaded) {
            hasLoaded = true;
            setLoaded({ kind, since: sinceRef.current ?? {} });
          }
        });
    };
    refresh();
    // A later deploy can replace the waiting worker without changing `kind`.
    // Refresh while ready so the banner follows its new changelog.
    const interval = kind === "ready" ? window.setInterval(refresh, READY_CHANGELOG_REFRESH_INTERVAL_MS) : undefined;
    return () => {
      current = false;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [kind]);
  if (!loaded) return null;

  const open = kind === loaded.kind;
  const { release } = loaded;
  if (loaded.kind === "ready") {
    const incoming = release && isNewerVersion(release.version, APP_VERSION) ? release.version : undefined;
    const reload = () => {
      // Someone up to date has just read what is coming, so the load it brings
      // needs no second announcement. An unacknowledged update keeps its own.
      if (incoming && !since) recordReloadingInto(incoming);
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
  }
  return (
    <UpdateBannerView
      highlight={leadHighlight(release, (version) => isNewRelease(version, loaded.since))}
      onDismiss={onDismiss}
      onOpenWhatsNew={onOpenWhatsNew}
      open={open}
      title={
        loaded.since.from
          ? localizer.message("ui.update.updatedFrom", { from: loaded.since.from, to: APP_VERSION })
          : localizer.message("ui.update.updatedTo", { version: APP_VERSION })
      }
    />
  );
};

export { UpdateBanner, UpdateBannerView };
export type { UpdateBannerKind };
