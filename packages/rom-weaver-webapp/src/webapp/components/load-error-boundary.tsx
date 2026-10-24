import { Component, type ErrorInfo, type ReactNode, useId } from "react";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";

/**
 * Keeps one failed part of the page from taking the rest down. Without a
 * boundary React unmounts the whole root on an uncaught render error, and with
 * it every panel's staged work. The usual cause is a lazy chunk that a deploy
 * has already replaced on the host, so the import 404s; React caches that
 * rejection, so only a reload recovers.
 */

const logger = createLogger("load-error-boundary");

// The 404 page's waiting surface, so a failed load looks like the app's other dead end.
const LoadFailedNotice = ({ onReload }: { onReload: () => void }) => {
  const localizer = useUiLocalizer();
  // Several hidden panels can fail at once.
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="not-found-page" role="alert">
      <div className="not-found-content">
        <h1 className="not-found-label" id={titleId}>
          {localizer.message("ui.loadFailed.title")}
        </h1>
        <p className="not-found-copy">{localizer.message("ui.loadFailed.copy")}</p>
        <div className="not-found-actions">
          <button className="btn primary" onClick={onReload} type="button">
            {localizer.message("ui.update.reload")}
          </button>
        </div>
      </div>
    </section>
  );
};

type LoadErrorBoundaryProps = {
  /** Names the part of the page in the log. */
  area: string;
  children: ReactNode;
  /** Stands in for the whole app, centered the way the 404 page centers its surface. */
  fullPage?: boolean;
  onReload: () => void;
};

class LoadErrorBoundary extends Component<LoadErrorBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    logger.warn("Part of the page failed to render", {
      area: this.props.area,
      componentStack: info.componentStack ?? "",
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const notice = <LoadFailedNotice onReload={this.props.onReload} />;
    return this.props.fullPage ? <main className="workbench is-not-found">{notice}</main> : notice;
  }
}

export { LoadErrorBoundary };
