import { useCallback, useEffect, useRef, useState } from "react";
import { FileDiff } from "lucide-react";
import type { BrowserCreateResult, WorkflowProgress } from "../../platform/browser/browser-api.ts";
import type { CreateSettings } from "../../types/settings.ts";
import {
  getPreferredCreatePatchFormat,
  getSelectableCreatePatchFormats,
} from "../../lib/create/patch-format-limits.ts";
import { removeKnownOutputExtension } from "../../lib/output/output-name-validation.ts";
import { sanitizeTypedOutputName } from "../../lib/path-utils.ts";
import { formatCodedErrorForDisplay } from "../../presentation/errors.ts";
import { Notice } from "./components/ds/feedback.tsx";
import type { OutputCardProps } from "./components/ds/output-card.tsx";
import { OutputRunAction } from "./components/ds/workflow-output-step.tsx";
import { releaseLargeEntries } from "./emulator-session-store.ts";
import { resolveCreateExecutionOutputName } from "./create-patch-output-model.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { createWorkflowFormProgress, toWorkflowFileProgressProps } from "./workflow-run-hooks.ts";
import type { WorkflowFormProgressState } from "./workflow-run-hooks.ts";

type CombinedPatchRunner = (options: {
  settings: Partial<CreateSettings>;
  signal: AbortSignal;
  onProgress: (event: WorkflowProgress) => void;
}) => Promise<BrowserCreateResult>;

const useCombinedPatch = ({
  run,
  revision,
  name,
  ready,
  disabled,
  patchType,
  defaultPatchType,
  onPatchTypeChange,
  romSize,
  patchTargetSize,
  lastDeclaredTargetSize,
  maxKnownTargetSize,
  tailMaxWriteEnd,
  settings,
  onComplete,
  onError,
}: {
  run: CombinedPatchRunner;
  revision: string;
  name: string;
  ready: boolean;
  disabled: boolean;
  patchType?: string;
  defaultPatchType?: string;
  onPatchTypeChange?: (value: string) => void;
  romSize?: number;
  patchTargetSize?: number;
  lastDeclaredTargetSize?: number;
  maxKnownTargetSize?: number;
  tailMaxWriteEnd?: number;
  settings?: CreateSettings;
  onComplete?: (result: BrowserCreateResult) => void;
  onError?: (error: Error) => void;
}) => {
  const localizer = useUiLocalizer();
  const [fileName, setFileName] = useState("");
  const [internalFormat, setInternalFormat] = useState(defaultPatchType || "bps");
  // Preparing the run re-stages its sources and briefly clears their sizes, so a running job MUST keep the sizes it started with.
  const [runSizes, setRunSizes] = useState<{
    patchTargetSize?: number;
    lastDeclaredTargetSize?: number;
    maxKnownTargetSize?: number;
    romSize?: number;
    tailMaxWriteEnd?: number;
  } | null>(null);
  const formatSizes = runSizes ?? {
    patchTargetSize,
    lastDeclaredTargetSize,
    maxKnownTargetSize,
    romSize,
    tailMaxWriteEnd,
  };
  // Known growth MUST still constrain format limits when another patch leaves shrinking uncertain.
  // The largest known size also sets the best-first order, so the fallback matches its size bucket.
  // It is not the pair Create indexes (an intermediate may shrink), so the BPS pair cap is left to the final size.
  const largestKnownSize = Math.max(formatSizes.romSize ?? 0, formatSizes.maxKnownTargetSize ?? 0);
  const knownTargetFormats = getSelectableCreatePatchFormats({
    applyBpsMemoryCap: false,
    modifiedSize: largestKnownSize,
  });
  // Format buckets and shrink limits keep using the largest known size for an undeclared final patch.
  const finalTargetSize = formatSizes.patchTargetSize ?? largestKnownSize;
  // BPS, UPS and VCDIFF report a target size; other headers declare one the engine does not report, and
  // PPF, BDF, APS GBA, RUP and IPS32 can grow the output past its start. An undeclared tail starts from the
  // last declared size (the ROM when none) only if every tail patch is bounded (24-bit IPS, EBP: no write
  // ends past tailMaxWriteEnd); otherwise the final size is unknowable and the largest known size is
  // assumed, since a wrongly offered BPS is only rejected after the whole chain has been applied.
  const tailStartSize = formatSizes.lastDeclaredTargetSize ?? formatSizes.romSize ?? 0;
  const bpsCapTargetSize =
    formatSizes.patchTargetSize ??
    (formatSizes.tailMaxWriteEnd === undefined
      ? largestKnownSize
      : Math.max(tailStartSize, formatSizes.tailMaxWriteEnd));
  const finalTargetFormats = getSelectableCreatePatchFormats({
    bpsCapModifiedSize: bpsCapTargetSize,
    originalSize: formatSizes.romSize,
    modifiedSize: finalTargetSize,
  });
  const candidateFormats = knownTargetFormats.filter((value) => finalTargetFormats.includes(value));
  // Create rejects formats outside the size policy, so a choice that no longer fits falls back to the first that does.
  const format = getPreferredCreatePatchFormat({
    automaticFormatSelection: false,
    bpsCapModifiedSize: bpsCapTargetSize,
    candidateFormats,
    modifiedSize: finalTargetSize,
    originalSize: formatSizes.romSize,
    requestedFormat: patchType || internalFormat,
  });
  const setFormat = (value: string) => {
    setInternalFormat(value);
    onPatchTypeChange?.(value);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<WorkflowFormProgressState | null>(null);
  const [completed, setCompleted] = useState<BrowserCreateResult | null>(null);
  const controller = useRef<AbortController | null>(null);
  const output = useRef<BrowserCreateResult | null>(null);
  const notifiedOutput = useRef<BrowserCreateResult | null>(null);
  const generation = useRef<{ revision: string; settingsSignature: string } | null>(null);
  // Preparing the run re-estimates the caller's display name, so a running job MUST keep the name it started with.
  const [runName, setRunName] = useState<string | null>(null);
  const resolvedName =
    sanitizeTypedOutputName(fileName) ||
    `${removeKnownOutputExtension(sanitizeTypedOutputName(runName ?? name) || "combined")}-combined`;
  const executionSettings: Partial<CreateSettings> = {
    ...settings,
    format: format as CreateSettings["format"],
    output: {
      ...settings?.output,
      compression: "none",
      outputName: resolveCreateExecutionOutputName(resolvedName, format),
    },
  };
  const settingsSignature = JSON.stringify(executionSettings);
  const disposeOutput = useCallback(() => {
    const previous = output.current;
    output.current = null;
    notifiedOutput.current = null;
    if (previous) void previous.output.dispose().catch(() => undefined);
  }, []);
  useEffect(() => {
    generation.current = { revision, settingsSignature };
    controller.current?.abort();
    controller.current = null;
    disposeOutput();
    setCompleted(null);
    setError("");
    setRunName(null);
    setRunSizes(null);
    setBusy(false);
    setProgress(null);
    return () => {
      generation.current = null;
      controller.current?.abort();
      controller.current = null;
      disposeOutput();
    };
  }, [disposeOutput, revision, settingsSignature]);
  const runPatch = async () => {
    if (controller.current || disabled || !ready) return;
    const currentGeneration = generation.current;
    const abortController = new AbortController();
    controller.current = abortController;
    setRunName(name);
    setRunSizes(formatSizes);
    setBusy(true);
    setError("");
    const isCurrent = () => !abortController.signal.aborted && currentGeneration === generation.current;
    try {
      let result = output.current;
      const cached = !!result;
      if (!result) {
        // This run publishes no workbench activity, so it closes a paused disc-sized Test game itself.
        releaseLargeEntries({ announce: true });
        result = await run({
          settings: executionSettings,
          signal: abortController.signal,
          onProgress: (event) => {
            if (isCurrent()) setProgress(createWorkflowFormProgress(event, "create"));
          },
        });
        if (!isCurrent()) {
          await result.output.dispose();
          return;
        }
        output.current = result;
        setCompleted(result);
        void result.output.prepareDownload?.().catch(() => undefined);
      }
      await result.output.saveAs(cached ? { interactive: true } : undefined);
      if (!isCurrent()) return;
      if (notifiedOutput.current !== result) {
        notifiedOutput.current = result;
        onComplete?.(result);
      }
    } catch (reason) {
      if (!isCurrent()) return;
      const normalized = reason instanceof Error ? reason : new Error(String(reason));
      setError(formatCodedErrorForDisplay(normalized));
      onError?.(normalized);
    } finally {
      if (controller.current === abortController) {
        controller.current = null;
        setRunName(null);
        setRunSizes(null);
        setBusy(false);
        setProgress(null);
      }
    }
  };
  const outputProps: OutputCardProps = {
    fileName: fileName || resolvedName,
    fileNameId: "rom-weaver-combined-patch-name",
    fileNameLabel: localizer.message("ui.combinedPatch.filename"),
    onFileNameChange: setFileName,
    format,
    outputExtensions: [format],
    formatId: "rom-weaver-combined-patch-format",
    formatLabel: localizer.message("ui.combinedPatch.format"),
    // candidateFormats already satisfy the final size policy, including the BPS pair cap.
    formatOptions: candidateFormats.map((value) => ({ label: `.${value}`, value })),
    onFormatChange: setFormat,
    disabled: disabled || busy,
    action: (
      <>
        <p className="patch-off-note">{localizer.message("ui.combinedPatch.description")}</p>
        {error ? <Notice level="error">{error}</Notice> : null}
        {busy ? (
          <>
            <OutputRunAction
              progress={toWorkflowFileProgressProps(progress)}
              disabled
              icon={<FileDiff aria-hidden="true" />}
            >
              {localizer.message("ui.combinedPatch.working")}
            </OutputRunAction>
            <button className="btn ghost" onClick={() => controller.current?.abort()} type="button">
              {localizer.message("ui.common.cancel")}
            </button>
          </>
        ) : (
          <OutputRunAction
            disabled={disabled || !ready}
            icon={<FileDiff aria-hidden="true" />}
            onClick={() => void runPatch()}
          >
            {localizer.message(completed ? "ui.combinedPatch.download" : "ui.combinedPatch.create")}
          </OutputRunAction>
        )}
      </>
    ),
  };
  return { busy, outputProps, run: runPatch, cancel: () => controller.current?.abort() };
};

export { useCombinedPatch };
