import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_VERSION } from "../build-version.ts";
import { isNewerVersion, isNewRelease, type UpdatedSince, writeLastSeenVersion } from "../last-seen-version.ts";
import { fetchChangelog, HIGHLIGHTS_TITLE, type ReleaseChangelog } from "./changelog-source.tsx";
import { BannerDismissButton, Reveal } from "./shell.tsx";

/**
 * One banner for both ends of an update: a deploy waiting to load ("ready") and
 * the first load of a newer release for a returning visitor ("updated"). Each
 * leads with one highlight and leaves the rest to What's new.
 */

const logger = createLogger("update-banner");

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
  // What the banner last loaded for its kind. The changelog is refetched
  // whenever the kind changes, because a deploy that becomes ready rewrites
  // changelog.json, and the banner opens only once that copy has settled. The
  // snapshot keeps the closing banner's words steady while it slides away.
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
    const settle = (release?: ReleaseChangelog) => {
      if (current) setLoaded({ kind, release, since: sinceRef.current ?? {} });
    };
    fetchChangelog()
      .then(({ release }) => settle(release))
      .catch((error) => {
        // The banner still names the update; only the highlight is lost.
        logger.debug("Update banner changelog unavailable", { kind, message: String(error) });
        settle();
      });
    return () => {
      current = false;
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
      if (incoming && !since) writeLastSeenVersion(incoming);
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
