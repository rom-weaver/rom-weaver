import Download from "lucide-react/dist/esm/icons/download.js";
import Scissors from "lucide-react/dist/esm/icons/scissors.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import {
  type BrowserSaveDestination,
  type BrowserTrimResult,
  type CreateSettings,
  TrimWorkflow,
  type WorkflowProgress,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { createProgressViewModelFromEvent, formatByteSize } from "../../presentation/workflow-presentation.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { CompressPanelBody } from "./components/ds/compress-panel.tsx";
import { ExtractionTree } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice, RunButton } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import { OutputCard } from "./components/ds/output-card.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, TrimPatchFormProps, TrimPatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  normalizeDefaultArchive,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import {
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
} from "./workflow-adapters.ts";

const FILE_EXTENSION_REGEX = /\.[^./\\]+$/;

const createWorkflowId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const mergeTrimSettings = (
  baseSettings: TrimPatchFormSettings | undefined,
  overrideSettings: TrimPatchFormSettings | undefined,
): TrimPatchFormSettings => {
  const merged = { ...(baseSettings || {}), ...(overrideSettings || {}) } as TrimPatchFormSettings;
  if (baseSettings?.output || overrideSettings?.output) {
    merged.output = {
      ...(baseSettings?.output || {}),
      ...(overrideSettings?.output || {}),
    };
  }
  return merged;
};

// Raw extension keeps the trimmed bytes uncompressed; zip/7z wrap the trimmed file in an archive.
const getSourceExtension = (fileName: string) => {
  const match = fileName.match(FILE_EXTENSION_REGEX);
  return match ? match[0].slice(1).toLowerCase() : "bin";
};

const getDefaultTrimOutputName = (sourceFileName: string, outputFormat: string) => {
  const baseName = sourceFileName.replace(FILE_EXTENSION_REGEX, "") || "trimmed";
  if (outputFormat === "zip") return `${baseName}.zip`;
  if (outputFormat === "7z") return `${baseName}.7z`;
  return `${baseName}.${outputFormat || getSourceExtension(sourceFileName)}`;
};

const resolveTrimExecutionOutputName = (outputName: string, outputFormat: string, sourceFileName: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  if (outputFormat === "zip" || outputFormat === "7z")
    return appendFileNameExtension(normalizedOutputName, outputFormat);
  return appendFileNameExtension(normalizedOutputName, outputFormat || getSourceExtension(sourceFileName));
};

const getCompletedDownloadMeta = (fileName: string, size?: number | null) => ({
  format: "Trimmed",
  name: fileName,
  size: typeof size === "number" && Number.isFinite(size) ? formatByteSize(size) : undefined,
});

function TrimPatchForm(props: TrimPatchFormProps) {
  const providerSettings = useCreateSettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  const [internalSource, setInternalSource] = useState<BinarySource | null>(props.defaultSource || null);
  const [internalSettings, setInternalSettings] = useState<TrimPatchFormSettings>(() =>
    mergeTrimSettings(providerSettings, props.defaultSettings),
  );
  const [internalOutputFormat, setInternalOutputFormat] = useState(props.defaultOutputFormat || "");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [completedOutput, setCompletedOutput] = useState<{
    fileName: string;
    saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
    size?: number;
  } | null>(null);
  const [progress, setProgress] = useState<{
    indeterminate: boolean;
    label: string;
    message: string;
    percent: number | null;
    role?: string;
    stage?: string;
    visualPercent: number | null;
  } | null>(null);
  const [outputName, setOutputName] = useState("");
  const activeOutputDisposeRef = useRef<(() => Promise<void> | void) | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const workflowIdRef = useRef(createWorkflowId("react-trim"));
  const selectedSourceCandidateIdRef = useRef<string | null>(null);

  const source = props.source === undefined ? internalSource : props.source;
  const settings = props.settings || internalSettings || providerSettings;
  const outputFormat = props.outputFormat ?? internalOutputFormat;
  const disabled = !!props.disabled || busy;
  const actionDisabled = !!props.disabled || !(busy || completedOutput || source);
  const sourceFileName = getReactBinarySourceFileName(source, "ROM");
  const resolvedOutputFormat = outputFormat || normalizeDefaultArchive(settings.defaultArchive);
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const generatedOutputName =
    configuredOutputName || (source ? getDefaultTrimOutputName(sourceFileName, resolvedOutputFormat) : "");
  const resolvedOutputName = outputName.trim() || generatedOutputName;
  const executionOutputName = resolveTrimExecutionOutputName(resolvedOutputName, resolvedOutputFormat, sourceFileName);

  useEffect(() => {
    if (props.settings !== undefined) return;
    setInternalSettings(mergeTrimSettings(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const disposeActiveOutput = useCallback(() => {
    const dispose = activeOutputDisposeRef.current;
    activeOutputDisposeRef.current = null;
    if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
  }, []);

  const updateSource = (file: BinarySource | null) => {
    disposeActiveOutput();
    setCompletedOutput(null);
    selectedSourceCandidateIdRef.current = null;
    if (props.source === undefined) setInternalSource(file);
    props.onSourceChange?.(file);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  cancelSelectionRef.current = () => updateSource(null);

  const updateSettings = (nextSettings: TrimPatchFormSettings) => {
    disposeActiveOutput();
    setCompletedOutput(null);
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updateOutputFormat = (nextOutputFormat: string) => {
    disposeActiveOutput();
    setCompletedOutput(null);
    if (props.outputFormat === undefined) setInternalOutputFormat(nextOutputFormat);
    props.onOutputFormatChange?.(nextOutputFormat);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const runTrim = async () => {
    if (completedOutput) {
      await completedOutput.saveAs();
      return;
    }
    if (!source) return;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    setBusy(true);
    setMessage("");
    setErrorCode("");
    disposeActiveOutput();
    setCompletedOutput(null);
    setProgress({
      indeterminate: true,
      label: "Trimming...",
      message: "Trimming...",
      percent: null,
      role: "worker",
      stage: "trim",
      visualPercent: null,
    });
    const outputCompression =
      resolvedOutputFormat === "zip" || resolvedOutputFormat === "7z" ? resolvedOutputFormat : "none";
    const trimWorkflow = new TrimWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: workflowIdRef.current,
      selectFile: async (request) => {
        const preferredCandidate = request.candidates.find(
          (candidate) => candidate.id === selectedSourceCandidateIdRef.current,
        );
        if (preferredCandidate?.selectable) return { id: preferredCandidate.id };
        return selectFile(request);
      },
      settings: toCreateWorkflowSettings(
        { ...settings, output: { ...settings.output, compression: outputCompression } } as CreateSettings,
        executionOutputName,
        props.workerThreads,
      ),
      signal: abortController.signal,
    });
    const handleProgress = (event: WorkflowProgress) => {
      props.onProgress?.(toReactProgressEvent(event));
      setProgress({
        ...createProgressViewModelFromEvent(event, { stage: event.stage || "trim" }),
        role: typeof event.role === "string" ? event.role : undefined,
        stage: typeof event.stage === "string" ? event.stage : "trim",
      });
    };
    trimWorkflow.on("progress", handleProgress);
    try {
      await trimWorkflow.setInput(toBrowserPublicBinarySource(source));
      await trimWorkflow.setOutputFormat(resolvedOutputFormat);
      await trimWorkflow.setOutputName(executionOutputName);

      if (trimWorkflow.getInput()?.status !== "ready" || !trimWorkflow.getInput()?.selectedCandidateId) {
        throw new Error("Trim source requires candidate selection");
      }

      const result = (await trimWorkflow.run()) as BrowserTrimResult;
      activeOutputDisposeRef.current = result.output.dispose;
      setCompletedOutput({
        fileName: result.output.fileName,
        saveAs: result.output.saveAs,
        size: result.sizeSummary?.outputSize ?? result.output.size,
      });
      setProgress(null);
      if (typeof window !== "undefined") await result.output.saveAs();
      props.onTrimComplete?.(result);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const code = getErrorCode(normalizedError);
      if (code === "WORKFLOW_SELECTION_SKIPPED") {
        setErrorCode("");
        setMessage("");
        setProgress(null);
        return;
      }
      setErrorCode(code);
      setMessage(
        formatCodedErrorForDisplay(
          normalizedError,
          createBrowserLocalizer((settings as { language?: string }).language),
        ),
      );
      setProgress(null);
      setCompletedOutput(null);
      props.onError?.(normalizedError);
    } finally {
      trimWorkflow.off("progress", handleProgress);
      await trimWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) activeAbortControllerRef.current = null;
      setBusy(false);
    }
  };

  const onRunClick = () => {
    if (busy) {
      activeAbortControllerRef.current?.abort();
      return;
    }
    if (!source) return;
    setConfirmOpen(true);
  };

  const onConfirmTrim = () => {
    setConfirmOpen(false);
    void runTrim();
  };

  useEffect(
    () => () => {
      activeAbortControllerRef.current?.abort();
      disposeActiveOutput();
    },
    [disposeActiveOutput],
  );

  const progressProps = progress
    ? {
        indeterminate: progress.indeterminate && progress.visualPercent === null && progress.percent === null,
        label: progress.label || progress.message || "Working…",
        percent: typeof progress.visualPercent === "number" ? progress.visualPercent : progress.percent,
        value: typeof progress.percent === "number" ? `${Math.round(progress.percent)}%` : "working",
      }
    : null;
  const showInputProgress = busy && progressProps && progress?.stage === "input" && progress.role === "input";

  const rawExtensionOption = source ? getSourceExtension(sourceFileName) : "bin";
  const formatOptions = [
    { label: `.${rawExtensionOption}`, value: rawExtensionOption },
    { label: ".zip", value: "zip" },
    { label: ".7z", value: "7z" },
  ];

  return (
    <main aria-labelledby="tab-trim" className="panel" id="trim-builder-container">
      <StepSection
        info={
          <InfoPopover title="ROM input">
            <strong>ROM</strong>
            <ul>
              <li>Drop an over-dumped ROM (NDS/N64 and similar) to remove trailing padding.</li>
              <li>Archives are extracted; pick the ROM if several candidates are found.</li>
            </ul>
          </InfoPopover>
        }
        num="01"
        title="ROM"
      >
        {source ? (
          showInputProgress && progressProps ? (
            <FileProgress {...progressProps} />
          ) : (
            <FileCard
              name={<ExtractionTree levels={[{ name: sourceFileName }]} />}
              onRemove={() => updateSource(null)}
              removeLabel="Clear ROM"
            />
          )
        ) : null}
        <DropZone
          big={!source}
          disabled={disabled}
          hint={source ? undefined : "archives are extracted"}
          label={source ? "Replace ROM · drop or browse" : "Select ROM · drop or browse"}
          onFiles={(files) => updateSource(files[0] ?? null)}
        />
      </StepSection>
      <StepSection
        info={
          <InfoPopover title="Output options">
            <strong>Output</strong>
            <ul>
              <li>Set the filename without an extension — the format selector controls it.</li>
              <li>Trimming permanently removes trailing padding from the ROM and can't be undone.</li>
              <li>Choose the raw extension to keep the trimmed bytes, or zip/7z to compress them.</li>
            </ul>
          </InfoPopover>
        }
        num="02"
        title="Trim"
      >
        <OutputCard
          action={
            <>
              {busy && progressProps && progress?.stage !== "input" ? <FileProgress {...progressProps} /> : null}
              <RunButton
                disabled={actionDisabled}
                download={
                  completedOutput ? getCompletedDownloadMeta(completedOutput.fileName, completedOutput.size) : undefined
                }
                icon={
                  completedOutput ? <Download aria-hidden="true" /> : busy ? undefined : <Scissors aria-hidden="true" />
                }
                id="trim-builder-button-run"
                onClick={() => (completedOutput ? void runTrim() : onRunClick())}
              >
                {busy ? "Cancel" : "TRIM & DOWNLOAD"}
              </RunButton>
            </>
          }
          compress={(() => {
            const panel = buildCompressPanel(resolvedOutputFormat, settings as Record<string, unknown>);
            return panel
              ? {
                  children: (
                    <CompressPanelBody
                      disabled={disabled}
                      fields={panel.fields}
                      onChange={(key, value) => updateSettings({ ...settings, [key]: value })}
                    />
                  ),
                  summary: panel.summary,
                }
              : null;
          })()}
          disabled={disabled}
          fileName={resolvedOutputName}
          fileNameId="trim-builder-output-file"
          fileNamePlaceholder="Trimmed filename (no extension)"
          format={resolvedOutputFormat}
          formatId="trim-builder-select-output-format"
          formatOptions={formatOptions}
          onFileNameChange={(value) => {
            setOutputName(value);
            updateSettings({
              ...settings,
              output: { ...settings.output, outputName: value.trim() || undefined },
            });
          }}
          onFormatChange={updateOutputFormat}
        />
        {message ? (
          <Notice id="trim-builder-row-error-message" level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}>
            {message}
          </Notice>
        ) : null}
      </StepSection>
      <ConfirmDialog
        body={`Trimming is permanent — it removes trailing padding from ${sourceFileName} and can't be undone.`}
        cancelLabel="Cancel"
        confirmLabel="Trim ROM"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={onConfirmTrim}
        open={confirmOpen}
        title="Trim ROM permanently?"
      />
      {candidateSelectionDialog}
    </main>
  );
}

export { TrimPatchForm };
