import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { Modal } from "../../public/react/components/ds/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_BUILD_VERSION, COMMIT_HASH } from "../build-version.ts";

/**
 * The "What's new" dialog behind the update banner's version affordance. Fetches
 * the deploy-root `changelog.json` (emitted by the build from `git log`) with
 * cache: "no-store" so a pending update surfaces the INCOMING deploy's commits,
 * not the stale copy the running bundle shipped with. The list is sliced to the
 * commits newer than the running build so it reads as "what you're about to get".
 */

const logger = createLogger("changelog-dialog");

type ChangelogEntry = { hash: string; subject: string; date: string };

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; entries: ChangelogEntry[]; truncated: boolean };

// Commits newer than the running build are everything before its hash in the
// (newest-first) log. If the running hash isn't in the window the client is more
// than one changelog-length behind, so show the whole window and flag the tail.
const commitsSinceCurrent = (entries: ChangelogEntry[]): { entries: ChangelogEntry[]; truncated: boolean } => {
  const index = entries.findIndex((entry) => entry.hash === COMMIT_HASH);
  if (index === -1) return { entries, truncated: true };
  return { entries: entries.slice(0, index), truncated: false };
};

const fetchChangelog = async (): Promise<ChangelogEntry[]> => {
  const response = await fetch(`./changelog.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`changelog fetch failed: ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("changelog is not an array");
  return data.filter(
    (entry): entry is ChangelogEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as ChangelogEntry).hash === "string",
  );
};

const formatDate = (iso: string) => iso.split("T")[0] || "";

const ChangelogDialog = ({ open, onClose, onReload }: { open: boolean; onClose: () => void; onReload: () => void }) => {
  const localizer = useUiLocalizer();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setState({ status: "loading" });
    fetchChangelog()
      .then((all) => {
        if (!active) return;
        const { entries, truncated } = commitsSinceCurrent(all);
        setState({ entries, status: "loaded", truncated });
      })
      .catch((error) => {
        if (!active) return;
        logger.warn("Changelog load failed", { message: String(error) });
        setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [open, attempt]);

  return (
    <Modal onClose={onClose} open={open} title={localizer.message("ui.update.whatsNew")}>
      {state.status === "loading" ? <div className="changelog-note">…</div> : null}
      {state.status === "error" ? (
        <div className="changelog-note">
          <button className="btn slim ghost" onClick={() => setAttempt((n) => n + 1)} type="button">
            {localizer.message("ui.common.retry")}
          </button>
        </div>
      ) : null}
      {state.status === "loaded" ? (
        <>
          <ul className="changelog">
            {state.entries.map((entry) => (
              <li className="changelog-item" key={entry.hash}>
                <span className="changelog-subject">{entry.subject}</span>
                <span className="changelog-meta mono">
                  {entry.hash}
                  {entry.date ? ` · ${formatDate(entry.date)}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {state.truncated ? <div className="changelog-note">…</div> : null}
          {/* No newer commits: a same-commit rebuild (notably dirty dev deploys, whose
              uncommitted changes never reach git log). Fall back to the build id — the
              one thing that differs between such builds — so the dialog isn't blank. */}
          {state.entries.length === 0 && !state.truncated ? (
            <div className="changelog-note mono">{APP_BUILD_VERSION}</div>
          ) : null}
        </>
      ) : null}
      <div className="changelog-note">{localizer.message("ui.update.note")}</div>
      <div className="changelog-actions">
        <button className="btn ghost" onClick={onClose} type="button">
          {localizer.message("ui.update.later")}
        </button>
        <button className="btn primary" onClick={onReload} type="button">
          {localizer.message("ui.update.reloadNow")}
        </button>
      </div>
    </Modal>
  );
};

export { ChangelogDialog };
