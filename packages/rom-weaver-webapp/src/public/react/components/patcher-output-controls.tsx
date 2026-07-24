import { Download } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
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
  const progress = state.applyButton.progress;
  const running = state.applyButton.loading || !!progress;
  const downloadReady = !!state.pendingDownloadFileName && !running;
  // The run button, the live-progress panel, and the finished download button
  // share one slot at the bottom of a long form. On mobile that slot sits below
  // the fold, and while weaving the per-row progress that expands above it keeps
  // pushing it further down. Keep it visible: reveal it (centered) when a run
  // starts and when the download is ready, and re-pin the progress panel as the
  // page grows during the run - but only when it has actually drifted below the
  // fold, so a user who scrolls up isn't yanked back while it's already in view.
  // While running the panel is `rom-weaver-progress-apply`; idle/ready it's the
  // `rom-weaver-button-apply` element. Refs seed to the mount value so an
  // already-active/ready state (e.g. restored session) never scrolls unprompted.
  const wasRunningRef = useRef(running);
  const wasDownloadReadyRef = useRef(downloadReady);
  useEffect(() => {
    const target =
      document.getElementById("rom-weaver-progress-apply") || document.getElementById("rom-weaver-button-apply");
    if (!target) return;
    const startedRunning = running && !wasRunningRef.current;
    const becameReady = downloadReady && !wasDownloadReadyRef.current;
    if (startedRunning || becameReady) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    } else if (progress && target.getBoundingClientRect().bottom > window.innerHeight) {
      target.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
    }
    wasRunningRef.current = running;
    wasDownloadReadyRef.current = downloadReady;
  }, [running, downloadReady, progress]);
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
