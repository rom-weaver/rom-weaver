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
    /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|bad alloc|ENOMEM|OOM)\b/i.test(message);
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
