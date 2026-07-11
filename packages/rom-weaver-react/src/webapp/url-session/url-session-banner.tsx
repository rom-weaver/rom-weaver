import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { Reveal } from "../components/shell.tsx";
import type { UrlSessionBootState } from "./use-url-session-boot.ts";

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Status banner for URL-driven sessions (`?manifest=` / `?rom=&patch=`):
 * download progress while sources stream in, and a retryable error when a
 * host refuses (CORS) or a download fails.
 */
const UrlSessionBanner = ({ state, onRetry }: { state: UrlSessionBootState; onRetry: () => void }) => {
  const localizer = useUiLocalizer();
  const open = state.phase === "fetching" || state.phase === "error";
  const progressText =
    state.totalBytes === null
      ? formatMebibytes(state.loadedBytes)
      : `${formatMebibytes(state.loadedBytes)} / ${formatMebibytes(state.totalBytes)}`;
  return (
    <Reveal open={open}>
      <div className="updates" data-testid="rom-weaver-url-session-banner" role="status">
        {state.phase === "error" ? (
          <>
            <span className="updates-text">
              <b>{localizer.message("ui.urlSession.error")}</b> <span className="mono">{state.errorDetail}</span>
              {state.errorKind === "blocked" ? <> {localizer.message("ui.urlSession.corsHint")}</> : null}
            </span>
            <button className="btn slim primary" onClick={onRetry} type="button">
              {localizer.message("ui.common.retry")}
            </button>
          </>
        ) : (
          <>
            <span aria-hidden="true" className="updates-pulse" />
            <span className="updates-text">
              <b>{localizer.message("ui.urlSession.loading")}</b>{" "}
              <span className="mono">
                {state.manifestName ? `${state.manifestName} - ` : ""}
                {progressText}
              </span>
            </span>
          </>
        )}
      </div>
    </Reveal>
  );
};

export { UrlSessionBanner };
