import { resolveAssetUrl } from "./asset-url.ts";
import { useRomWeaverAssetBaseUrl, useUiLocalizer } from "./settings-context.tsx";

/** Notices receive diagnostics already formatted by formatCodedErrorForDisplay. */
const WorkflowErrorMessage = ({ message }: { message: string }) => {
  const localizer = useUiLocalizer();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const code = /^([A-Z_]+): /.exec(message)?.[1];
  const memory =
    (code === "WORKER_FAILED" || code === "COMPRESSION_FAILED") &&
    /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|bad alloc|ENOMEM|OOM)\b/i.test(message);
  const recovery = memory
    ? "memory"
    : code === "ARCHIVE_DEPTH_EXCEEDED"
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
