import { Download } from "lucide-react";
import { useSyncExternalStore } from "react";
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
  totalTime,
}: {
  controller: OutputController;
  /** Extra gate (e.g. every staged patch toggled off). */
  disableRun?: boolean;
  /** Total wall time for the finished run (download button right edge). */
  totalTime?: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.pendingDownloadFileName && !state.applyButton.progress && !state.applyButton.loading) {
    // The button shows the output FORMAT (the loom dl-kind), not the filename -
    // the name already fills the output field above; the full name stays on
    // the accessible label.
    const extension = (state.pendingDownloadFileName.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
    const summary = state.downloadSummary;
    const kind = summary?.format || extension || "file";
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
        ariaLabel={`Download ${state.pendingDownloadFileName}`}
        disabled={state.applyButton.disabled}
        download={{
          format: `Patched ${kind}`,
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
      cancelLabel="Cancel weaving"
      disabled={state.applyButton.disabled || !!disableRun}
      icon={<ApplyBandaidIcon className="apply-button-icon" />}
      id="rom-weaver-button-apply"
      label={state.applyButton.label}
      loading={state.applyButton.loading}
      onCancel={controller.cancelPrimaryAction}
      onClick={() => controller.runPrimaryAction()}
      progress={state.applyButton.progress}
      progressId="rom-weaver-progress-apply"
    />
  );
}

export { PatcherPrimaryAction };
