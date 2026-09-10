import { Download } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useUiLocalizer } from "../settings-context.tsx";
import { RunButton } from "../components/ds/feedback.tsx";
import type { PatcherOutputState } from "../patcher-presentation.ts";
import { ApplyBandaidIcon } from "./apply-bandaid-icon.tsx";
import { ProgressActionButton } from "./progress-action-button.tsx";

type OutputController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => PatcherOutputState;
  cancelPrimaryAction?: () => void;
  setDisplayFileName: (value: string) => void;
  setOutputCompression: (value: string) => void;
  runPrimaryAction: () => void;
};

/** The apply form's primary action: download button when an output is ready, run/progress otherwise. */
function PatcherPrimaryAction({
  controller,
  disableRun,
  showCompletedDownload = true,
  totalTime,
}: {
  controller: OutputController;
  /** Extra gate (e.g. every staged patch toggled off). */
  disableRun?: boolean;
  /** Keep the completed output's Download action visible. */
  showCompletedDownload?: boolean;
  /** Total wall time for the finished run (download button right edge). */
  totalTime?: string;
}) {
  const localizer = useUiLocalizer();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.pendingDownloadFileName && !state.applyButton.progress && !state.applyButton.loading) {
    if (!showCompletedDownload) return null;
    // The button shows the output FORMAT (the loom dl-kind), not the filename -
    // the name already fills the output field above; the full name stays on
    // the accessible label.
    const extension = (state.pendingDownloadFileName.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    const summary = state.downloadSummary;
    const kind = summary?.format || extension || localizer.message("ui.common.file");
    // Show the size as a "from → to" transition (matching the extract badges)
    // when the input size is known and differs from the output; otherwise the
    // output size alone. The compression ratio trails in parentheses.
    const sizeTransition =
      summary?.fromSize && summary.size && summary.fromSize !== summary.size
        ? `${summary.fromSize} → ${summary.size}`
        : summary?.size;
    const sizeText = sizeTransition
      ? summary?.ratio
        ? `${sizeTransition} (${summary.ratio})`
        : sizeTransition
      : undefined;
    return (
      <RunButton
        ariaLabel={localizer.message("ui.output.downloadFile", { name: state.pendingDownloadFileName })}
        disabled={state.applyButton.disabled}
        download={{
          format: localizer.message("ui.output.patchedFormat", { format: kind }),
          size: sizeText,
          total: totalTime,
        }}
        icon={<Download aria-hidden="true" />}
        id="rom-weaver-button-apply"
        onClick={() => controller.runPrimaryAction()}
      />
    );
  }

  return (
    <ProgressActionButton
      cancelLabel={localizer.message("ui.output.cancelApply")}
      disabled={state.applyButton.disabled || !!disableRun}
      icon={<ApplyBandaidIcon className="apply-button-icon" />}
      id="rom-weaver-button-apply"
      label={
        state.pendingDownloadFileName
          ? localizer.message("ui.output.downloadFile", { name: state.pendingDownloadFileName })
          : localizer.message("ui.output.applyDownload")
      }
      loading={state.applyButton.loading}
      onCancel={controller.cancelPrimaryAction}
      onClick={() => controller.runPrimaryAction()}
      progress={state.applyButton.progress}
      progressId="rom-weaver-progress-apply"
    />
  );
}

export { PatcherPrimaryAction };
