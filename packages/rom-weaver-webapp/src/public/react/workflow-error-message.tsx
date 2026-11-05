import { resolveAssetUrl } from "./asset-url.ts";
import { useRomWeaverAssetBaseUrl, useUiLocalizer } from "./settings-context.tsx";
import { StorageFullRecovery } from "./storage-full-recovery.tsx";

/**
 * Display coded workflow errors with recovery guidance. The workflow code comes from `code`, else from the
 * `CODE: ` prefix `formatCodedErrorForDisplay` writes; engine failures carry theirs from the Rust error code.
 */
const WorkflowErrorMessage = ({
  code: codeProp,
  message,
  onRetry,
}: {
  code?: string;
  message: string;
  onRetry?: () => void;
}) => {
  const localizer = useUiLocalizer();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const code = codeProp ?? /^([A-Z_]+): /.exec(message)?.[1];
  const archiveDepth = code === "ARCHIVE_DEPTH_EXCEEDED";
  // Out-of-memory text comes from the browser's wasm runtime, not from engine diagnostics.
  const memory =
    !archiveDepth &&
    (code === "WORKER_FAILED" || code === "COMPRESSION_FAILED") &&
    /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|allocate memory|bad alloc|ENOMEM|OOM)\b/i.test(
      message,
    );
  if (code === "ARCHIVE_READ_FAILED") {
    return (
      <>
        {localizer.message("ui.errorRecovery.archiveRead")}
        <details>
          <summary>{localizer.message("ui.errorRecovery.details")}</summary>
          {message}
        </details>
      </>
    );
  }
  const recovery = memory
    ? "memory"
    : archiveDepth
      ? "archiveDepth"
      : code === "SELECTION_NOT_FOUND" || code === "NO_SELECTABLE_CANDIDATE"
        ? "selection"
        : null;
  return (
    <>
      {message}
      <StorageFullRecovery message={message} onRetry={onRetry} />
      {recovery ? (
        <>
          <br />
          {localizer.message(`ui.errorRecovery.${recovery}`)}{" "}
          <a
            href={resolveAssetUrl(assetBaseUrl, memory ? "docs/cli-get-started" : "docs/extract-files-browser")}
            target="_blank"
            rel="noreferrer"
          >
            {localizer.message(memory ? "ui.errorRecovery.cliGuide" : "ui.errorRecovery.archiveGuide")}
          </a>
        </>
      ) : null}
    </>
  );
};

export { WorkflowErrorMessage };
