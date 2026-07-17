import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice } from "./components/ds/feedback.tsx";
import { StageStatus, stageBarValue, stagePercent, stageStatusLabel } from "./components/ds/staging-meta.tsx";
import type { CreatePatchFormViewModel } from "./create-patch-form-view.tsx";
import {
  type CreateDisplaySourceState,
  getChecksumTimingLabel,
  getDisplaySourceChecksums,
  getDisplaySourceChecksumTiming,
  getDisplaySourceInfo,
  isChecksumProgress,
} from "./create-patch-output-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import {
  formatElapsedMs,
  getSourceNoticeLevel,
  getSourceNoticeMessage,
  hasSourceQueueWarning,
} from "./workflow-form-utils.ts";
import {
  toWorkflowChecksumProgressProps,
  type toWorkflowFileProgressProps,
  type WorkflowFormProgressState,
} from "./workflow-run-hooks.ts";

/**
 * Builds one create-patch source step (the Original / Modified row) view model
 * from its staged state plus the active runtime-notice slice. Extracted verbatim
 * from `CreatePatchForm.renderSourceStep`; it is a pure render-time projection
 * (no hooks) the form invokes once per source. The runtime-notice fields the
 * builder previously closed over are passed in explicitly via `runtimeNotice`.
 */

type CreateSourceStepRuntimeNotice = {
  message: string;
  messagePlacement: "modified" | "original" | "output" | null;
  errorCode: string;
  messageDismissible: boolean;
  clearWorkflowMessage: () => void;
};

type CreateSourceStepOptions = {
  num: string;
  role: "modified" | "original";
  title: string;
  file: BinarySource | null;
  fileName: string;
  sourceState: CreateDisplaySourceState | null;
  removeLabel: string;
  onClear: () => void;
  sourceProgress?: ReturnType<typeof toWorkflowFileProgressProps>;
  checksumProgress?: WorkflowFormProgressState | null;
  runtimeNotice: CreateSourceStepRuntimeNotice;
};

const buildCreateSourceStep = ({
  num,
  role,
  title,
  file,
  fileName,
  sourceState,
  removeLabel,
  onClear,
  sourceProgress = null,
  checksumProgress = null,
  runtimeNotice,
}: CreateSourceStepOptions): CreatePatchFormViewModel["originalStep"] => {
  const { message, messagePlacement, errorCode, messageDismissible, clearWorkflowMessage } = runtimeNotice;
  const displayInfo = getDisplaySourceInfo(sourceState, fileName);
  const sourceChecksumProgress = isChecksumProgress(checksumProgress) ? checksumProgress : null;
  // Staging treatment shared with the apply form: the resolved card stays mounted
  // and a slim determinate bar on its top edge + a status on the meta line carry
  // progress, rather than swapping the whole card for a bordered progress panel.
  const checksumProps = toWorkflowChecksumProgressProps(sourceChecksumProgress);
  const staging = !!sourceProgress || !!sourceChecksumProgress;
  const stagingProgress = sourceChecksumProgress ? checksumProps : sourceProgress;
  const stagePct = stagePercent(stagingProgress);
  // Only the source (extract) phase carries the "Extracting & …" verb; the
  // checksum phase reads plain "Checksumming…".
  const stageLabel = stageStatusLabel("Checksumming", !sourceChecksumProgress && !!sourceProgress);
  const stageBytes = displayInfo?.size ?? displayInfo?.sourceSize;
  const sourceNoticeMessage = getSourceNoticeMessage(sourceState);
  const runtimeNoticeVisible = !!message && messagePlacement === role;
  const notice = runtimeNoticeVisible ? (
    <Notice
      id={`patch-builder-${role}-error-message`}
      level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}
      onDismiss={messageDismissible ? clearWorkflowMessage : undefined}
    >
      {message}
    </Notice>
  ) : sourceNoticeMessage ? (
    <Notice id={`patch-builder-${role}-error-message`} level={getSourceNoticeLevel(sourceState)}>
      {sourceNoticeMessage}
    </Notice>
  ) : null;
  return {
    id: `patch-builder-row-${role}`,
    items: file
      ? [
          {
            card: {
              extract: {
                fileName,
                fileSize: displayInfo?.size,
                parentCompressions: displayInfo?.parentCompressions,
                timing: formatElapsedMs(displayInfo?.decompressionTimeMs),
              },
              meta: staging ? (
                <>
                  {typeof stageBytes === "number" ? (
                    <span className="fsize mono">{formatByteSize(stageBytes)}</span>
                  ) : null}
                  <StageStatus id={`${num}:stage`} label={stageLabel} percent={stagePct} />
                </>
              ) : undefined,
              onRemove: onClear,
              panels: {
                info: {
                  bytes: stageBytes,
                  checksums: getDisplaySourceChecksums(sourceState),
                  defaultOpen: false,
                  progress: checksumProps,
                  timing: getChecksumTimingLabel(getDisplaySourceChecksumTiming(sourceState)) || undefined,
                },
              },
              removeLabel,
              stageBar: stageBarValue(staging, stagePct),
              state: hasSourceQueueWarning(sourceState) ? "bad" : sourceState?.status === "ready" ? "ok" : undefined,
            },
            id: `${num}:card`,
          },
        ]
      : [],
    notice,
    num,
    title,
  };
};

export { buildCreateSourceStep, type CreateSourceStepRuntimeNotice };
