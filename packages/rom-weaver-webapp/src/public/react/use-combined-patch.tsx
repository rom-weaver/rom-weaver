import { useCallback, useEffect, useRef, useState } from "react";
import { FileDiff } from "lucide-react";
import type { BrowserCreateResult, WorkflowProgress } from "../../platform/browser/browser-api.ts";
import type { CreateSettings } from "../../types/settings.ts";
import { getPreferredCreatePatchFormat } from "../../lib/create/patch-format-limits.ts";
import { getFileNameWithoutExtension, sanitizeTypedOutputName } from "../../lib/path-utils.ts";
import { formatCodedErrorForDisplay } from "../../presentation/errors.ts";
import { Notice } from "./components/ds/feedback.tsx";
import type { OutputCardProps } from "./components/ds/output-card.tsx";
import { OutputRunAction } from "./components/ds/workflow-output-step.tsx";
import { createCreatePatchFormatOptions } from "./output-view-model.ts";
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
  settings?: CreateSettings;
  onComplete?: (result: BrowserCreateResult) => void;
  onError?: (error: Error) => void;
}) => {
  const localizer = useUiLocalizer();
  const [fileName, setFileName] = useState("");
  const [internalFormat, setInternalFormat] = useState(defaultPatchType || "bps");
  // Preparing the run re-stages its sources and briefly clears their sizes, so a running job MUST keep the sizes it started with.
  const [runSizes, setRunSizes] = useState<{ patchTargetSize?: number; romSize?: number } | null>(null);
  const formatSizes = runSizes ?? { patchTargetSize, romSize };
  // Create rejects formats outside the size policy, so a choice that no longer fits falls back to the first that does.
  const format = getPreferredCreatePatchFormat({
    automaticFormatSelection: false,
    modifiedSize: formatSizes.patchTargetSize,
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
    sanitizeTypedOutputName(fileName) || `${getFileNameWithoutExtension((runName ?? name) || "combined")}-combined`;
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
    formatId: "rom-weaver-combined-patch-format",
    formatLabel: localizer.message("ui.combinedPatch.format"),
    formatOptions: createCreatePatchFormatOptions({
      modifiedSize: formatSizes.patchTargetSize,
      originalSize: formatSizes.romSize,
    }),
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
