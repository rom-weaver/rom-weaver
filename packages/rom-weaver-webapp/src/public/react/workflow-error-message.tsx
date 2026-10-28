import { resolveAssetUrl } from "./asset-url.ts";
import { useRomWeaverAssetBaseUrl, useUiLocalizer } from "./settings-context.tsx";

/** Display coded workflow errors and native source-staging diagnostics with recovery guidance. */
const WorkflowErrorMessage = ({ message }: { message: string }) => {
  const localizer = useUiLocalizer();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const code = /^([A-Z_]+): /.exec(message)?.[1];
  const archiveDepth =
    code === "ARCHIVE_DEPTH_EXCEEDED" ||
    /^validation failed: nested extract exceeded max depth of \d+ at `/i.test(message) ||
    (code === "COMPRESSION_FAILED" && /\bnested extract exceeded max depth of \d+\b/i.test(message));
  const memory =
    !archiveDepth &&
    (code === "WORKER_FAILED" || code === "COMPRESSION_FAILED") &&
    /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|allocate memory|bad alloc|ENOMEM|OOM)\b/i.test(
      message,
    );
  // Open and read failures on a valid archive are storage problems, not archive damage.
  const storageFailure = /(?:Failed to open|Error reading) '/.test(message);
  const archiveRead =
    !(archiveDepth || memory || storageFailure) &&
    (!code || code === "COMPRESSION_FAILED" || code === "CHECKSUM_MISMATCH") &&
    /(?:^| Details: )validation failed: (?:[a-z0-9.]+ (?:(?:list|extract) failed while (?:reading|decoding) entry \d+(?: \(`.*?`\))?:|archive is invalid:)|archive read (?:header|data) failed:|unknown libarchive failure\b)/i.test(
      message,
    );
  if (archiveRead) {
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
