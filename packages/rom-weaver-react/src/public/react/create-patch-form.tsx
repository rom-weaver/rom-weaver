import Download from "lucide-react/dist/esm/icons/download.js";
import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import { resolveAutomaticSelection } from "../../lib/input/selection.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import {
  type BrowserCreateResult,
  type BrowserSaveDestination,
  type CreateSettings,
  CreateWorkflow,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { buildOutputCompressionPanel, getOutputCompressionFormatLabel } from "./components/ds/compress-panel.tsx";
import { Notice } from "./components/ds/feedback.tsx";
import { InfoPopover } from "./components/ds/layout.tsx";
import { OutputRunAction, WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import { createCreateOutputCompressionOptions, createCreatePatchFormatOptions } from "./output-view-model.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  normalizeDefaultArchive,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import {
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toStagedInputInfo,
} from "./workflow-adapters.ts";
import { createReactWorkflowId, createSettingsDependencyKey, mergeSettingsWithOutput } from "./workflow-form-utils.ts";
import {
  createIndeterminateWorkflowProgress,
  createWaitingWorkflowProgress,
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useActiveAbortController,
  useDisposableWorkflowOutput,
  useWorkflowProgressState,
  type WorkflowFormProgressState,
} from "./workflow-run-hooks.ts";

const resolveCreateExecutionOutputName = (outputName: string, patchType: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, patchType || "bps");
};

const getFileExtensionLabel = (fileName: string) => {
  const extension = fileName.trim().match(/(\.[^./\\]+)$/)?.[1];
  return extension || fileName;
};

const getCompressionRatioLabel = (
  compression: "7z" | "none" | "zip",
  outputSize?: number | null,
  rawSize?: number | null,
) => {
  if (compression === "none") return undefined;
  if (
    typeof outputSize !== "number" ||
    !Number.isFinite(outputSize) ||
    typeof rawSize !== "number" ||
    !Number.isFinite(rawSize) ||
    rawSize <= 0
  ) {
    return undefined;
  }
  return `${Math.round((outputSize / rawSize) * 100)}%`;
};

const getCompletedDownloadMeta = ({
  compression,
  fileName,
  patchType,
  rawSize,
  size,
}: {
  compression: "7z" | "none" | "zip";
  fileName: string;
  patchType: string;
  rawSize?: number | null;
  size?: number | null;
}) => ({
  format: `.${patchType || getFileExtensionLabel(fileName).replace(/^\./, "") || "patch"}`,
  name: compression === "none" ? undefined : getFileExtensionLabel(fileName),
  ratio: getCompressionRatioLabel(compression, size, rawSize),
  size: typeof size === "number" && Number.isFinite(size) ? formatByteSize(size) : undefined,
});

type CreateDisplaySourceState = CreateWorkflowSourceState;
type CompletedCreateOutput = {
  compression: "7z" | "none" | "zip";
  fileName: string;
  patchType: string;
  rawSize?: number;
  saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
  size?: number;
};

const getDisplaySourceInfo = (source: CreateDisplaySourceState | null | undefined, fallback: string) =>
  toStagedInputInfo(source, fallback);

const formatElapsedMs = (elapsedMs: number | undefined) =>
  typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatTiming(createTiming(elapsedMs)) : "";

const formatChecksumTiming = (elapsedMs: number | undefined) =>
  elapsedMs === 0 ? "from extract" : formatElapsedMs(elapsedMs);

const getDisplaySourceChecksums = (source: CreateDisplaySourceState | null | undefined) =>
  (source as (CreateDisplaySourceState & { checksums?: Record<string, string> }) | null | undefined)?.checksums;

const getDisplaySourceChecksumTiming = (source: CreateDisplaySourceState | null | undefined) =>
  formatChecksumTiming(
    (source as (CreateDisplaySourceState & { checksumTimeMs?: number }) | null | undefined)?.checksumTimeMs,
  );

const getChecksumTimingLabel = (timing: string) => (timing ? `Checksum ${timing}` : "");
const isChecksumProgress = (progress: WorkflowFormProgressState | null) =>
  !!progress && /checksum/i.test(`${progress.label} ${progress.message}`);

function CreatePatchForm(props: CreatePatchFormProps) {
  const providerSettings = useCreateSettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  const [internalOriginal, setInternalOriginal] = useState<BinarySource | null>(props.defaultOriginal || null);
  const [internalModified, setInternalModified] = useState<BinarySource | null>(props.defaultModified || null);
  const [internalSettings, setInternalSettings] = useState<CreatePatchFormSettings>(() =>
    mergeSettingsWithOutput(providerSettings, props.defaultSettings),
  );
  const [internalPatchType, setInternalPatchType] = useState(props.defaultPatchType || "bps");
  const [busy, setBusy] = useState(false);
  const [stagingRole, setStagingRole] = useState<"modified" | "original" | null>(null);
  const [message, setMessage] = useState("");
  const [originalState, setOriginalState] = useState<CreateDisplaySourceState | null>(null);
  const [modifiedState, setModifiedState] = useState<CreateDisplaySourceState | null>(null);
  const { clearCompletedOutput, completedOutput, disposeActiveOutput, rememberOutputDispose, setCompletedOutput } =
    useDisposableWorkflowOutput<CompletedCreateOutput>();
  const { abortActiveOperation, activeAbortControllerRef, rememberAbortController } = useActiveAbortController();
  const { clearProgressForStage, createProgressHandler, progress, setProgress } = useWorkflowProgressState({
    onProgress: props.onProgress,
  });
  const [outputName, setOutputName] = useState("");
  const stagingOriginalGenerationRef = useRef(0);
  const stagingModifiedGenerationRef = useRef(0);
  const stagedCreateWorkflowRef = useRef<CreateWorkflow | null>(null);
  const stagedCreateWorkflowGenerationRef = useRef(0);
  const stagedCreateWorkflowSyncRef = useRef({
    modifiedKey: "",
    originalKey: "",
    settingsKey: "",
  });
  const workflowIdRef = useRef(createReactWorkflowId("react-create"));
  const [errorCode, setErrorCode] = useState("");
  const original = props.original === undefined ? internalOriginal : props.original;
  const modified = props.modified === undefined ? internalModified : props.modified;
  const settings = props.settings || internalSettings || providerSettings;
  const patchType = props.patchType || internalPatchType;
  const disabled = !!props.disabled || busy || !!stagingRole;
  const uploadDisabled = !!props.disabled || busy;
  const actionDisabled =
    !!props.disabled ||
    !!stagingRole ||
    !(
      busy ||
      completedOutput ||
      (original && modified && originalState?.status === "ready" && modifiedState?.status === "ready")
    );
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const originalFileName = getReactBinarySourceFileName(original, "Original ROM");
  const modifiedFileName = getReactBinarySourceFileName(modified, "Modified ROM");
  const displayedOriginalInfo = getDisplaySourceInfo(originalState, originalFileName);
  const displayedModifiedInfo = getDisplaySourceInfo(modifiedState, modifiedFileName);
  const generatedOutputName =
    configuredOutputName ||
    getDefaultCreateOutputName(
      displayedOriginalInfo?.fileName ? new File([], displayedOriginalInfo.fileName) : original,
    );
  const resolvedOutputName = outputName.trim() || generatedOutputName;
  const executionOutputName = resolveCreateExecutionOutputName(resolvedOutputName, patchType);
  const createCompression = (() => {
    const normalized = String(settings.output?.compression || normalizeDefaultArchive(settings.defaultArchive))
      .trim()
      .toLowerCase();
    return normalized === "7z" ? "7z" : normalized === "none" ? "none" : "zip";
  })();
  const createCompressionOptions = useMemo(() => createCreateOutputCompressionOptions(patchType), [patchType]);
  const patchFormatOptions = useMemo(() => createCreatePatchFormatOptions(), []);
  const displayedOriginalFileName = displayedOriginalInfo?.fileName || originalFileName;
  const displayedModifiedFileName = displayedModifiedInfo?.fileName || modifiedFileName;
  const settingsLanguage = (settings as { language?: string }).language;
  const originalSourceKey = useMemo(
    () => (original ? getBinarySourceListStableIds([original])[0] || "" : ""),
    [original],
  );
  const modifiedSourceKey = useMemo(
    () => (modified ? getBinarySourceListStableIds([modified])[0] || "" : ""),
    [modified],
  );
  const stagingSettingsKey = useMemo(
    () =>
      createSettingsDependencyKey({
        input: settings.input,
        language: settingsLanguage,
        limits: settings.limits,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        workerThreads: props.workerThreads,
      }),
    [props.workerThreads, settings.input, settings.limits, settings.logging?.level, settings.workers, settingsLanguage],
  );
  const stagingSettings = useMemo(
    () =>
      toCreateWorkflowSettings(
        {
          input: settings.input,
          limits: settings.limits,
          logging: settings.logging,
          output: { compression: "none" },
          workers: settings.workers,
        } as never,
        "",
        props.workerThreads,
      ),
    [props.workerThreads, settings.input, settings.limits, settings.logging, settings.workers],
  );
  const stagingSettingsRef = useRef(stagingSettings);
  useEffect(() => {
    stagingSettingsRef.current = stagingSettings;
  }, [stagingSettings]);

  useEffect(() => {
    if (props.settings !== undefined) return;
    setInternalSettings(mergeSettingsWithOutput(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const updateOriginal = (file: BinarySource | null) => {
    disposeActiveOutput();
    clearCompletedOutput();
    stagedCreateWorkflowGenerationRef.current += 1;
    stagingOriginalGenerationRef.current += 1;
    setOriginalState(null);
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const updateModified = (file: BinarySource | null) => {
    disposeActiveOutput();
    clearCompletedOutput();
    stagedCreateWorkflowGenerationRef.current += 1;
    stagingModifiedGenerationRef.current += 1;
    setModifiedState(null);
    if (props.modified === undefined) setInternalModified(file);
    props.onModifiedChange?.(file);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  cancelSelectionRef.current = (request) => {
    if (request.role === "original") {
      updateOriginal(null);
      return;
    }
    if (request.role === "modified") updateModified(null);
  };

  const updateSettings = (nextSettings: CreatePatchFormSettings) => {
    disposeActiveOutput();
    clearCompletedOutput();
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updatePatchType = (nextPatchType: string) => {
    disposeActiveOutput();
    clearCompletedOutput();
    if (!props.patchType) setInternalPatchType(nextPatchType);
    props.onPatchTypeChange?.(nextPatchType);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const createSelectFileHandler = useCallback(
    (_role: "modified" | "original") => async (request: Parameters<typeof selectFile>[0]) => {
      const automaticSelection = resolveAutomaticSelection(request);
      return automaticSelection || selectFile(request);
    },
    [selectFile],
  );

  useEffect(() => {
    const generation = ++stagedCreateWorkflowGenerationRef.current;
    stagingOriginalGenerationRef.current = generation;
    stagingModifiedGenerationRef.current = generation;
    const previousSync = stagedCreateWorkflowSyncRef.current;
    const settingsChanged = previousSync.settingsKey !== stagingSettingsKey;
    const originalKeyChanged = previousSync.originalKey !== originalSourceKey;
    const modifiedKeyChanged = previousSync.modifiedKey !== modifiedSourceKey;
    const sourceCleared = (originalKeyChanged && !original) || (modifiedKeyChanged && !modified);
    const workflowReset = settingsChanged || sourceCleared || originalKeyChanged || modifiedKeyChanged;
    const originalChanged = workflowReset || originalKeyChanged;
    const modifiedChanged = workflowReset || modifiedKeyChanged;
    let workflow = stagedCreateWorkflowRef.current;
    if (workflowReset) {
      workflow?.dispose().catch(() => undefined);
      workflow = null;
      stagedCreateWorkflowRef.current = null;
    }
    if (originalChanged) setOriginalState(null);
    if (modifiedChanged) setModifiedState(null);
    stagedCreateWorkflowSyncRef.current = {
      modifiedKey: modifiedSourceKey,
      originalKey: originalSourceKey,
      settingsKey: stagingSettingsKey,
    };
    if (!(original || modified)) {
      setStagingRole(null);
      setProgress((current) => (current?.stage === "input" ? null : current));
      return;
    }
    if (!workflow) {
      workflow = new CreateWorkflow({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: `${workflowIdRef.current}:stage:${generation}`,
        selectFile: async (request) =>
          createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
        settings: stagingSettingsRef.current,
      });
      stagedCreateWorkflowRef.current = workflow;
    }
    const activeWorkflow = workflow;
    const handleProgress = createProgressHandler("input");
    activeWorkflow.on("progress", handleProgress);
    const isCurrentStaging = () =>
      stagedCreateWorkflowGenerationRef.current === generation && stagedCreateWorkflowRef.current === activeWorkflow;
    const finishStaging = async () => {
      try {
        if (originalChanged && original) {
          setStagingRole("original");
          await activeWorkflow.setOriginal(toBrowserPublicBinarySource(original));
          if (!isCurrentStaging()) return;
          setOriginalState(activeWorkflow.getOriginal());
          clearProgressForStage("input");
        }
        if (modifiedChanged && modified) {
          setStagingRole("modified");
          await activeWorkflow.setModified(toBrowserPublicBinarySource(modified));
          if (!isCurrentStaging()) return;
          setModifiedState(activeWorkflow.getModified());
          clearProgressForStage("input");
        }
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const code = getErrorCode(normalizedError);
        if (code === "WORKFLOW_SELECTION_SKIPPED" || !isCurrentStaging()) return;
        setErrorCode(code);
        setMessage(formatCodedErrorForDisplay(normalizedError, createBrowserLocalizer(settingsLanguage)));
        setOriginalState(activeWorkflow.getOriginal());
        setModifiedState(activeWorkflow.getModified());
        props.onError?.(normalizedError);
      } finally {
        activeWorkflow.off("progress", handleProgress);
        if (isCurrentStaging()) {
          setStagingRole(null);
          clearProgressForStage("input");
        }
      }
    };
    void finishStaging();
    return () => {
      activeWorkflow.off("progress", handleProgress);
    };
  }, [
    clearProgressForStage,
    createProgressHandler,
    createSelectFileHandler,
    modified,
    modifiedSourceKey,
    original,
    originalSourceKey,
    props.onError,
    resolvedAssetBaseUrl,
    settingsLanguage,
    stagingSettingsKey,
  ]);

  useEffect(
    () => () => {
      stagedCreateWorkflowGenerationRef.current += 1;
      const workflow = stagedCreateWorkflowRef.current;
      stagedCreateWorkflowRef.current = null;
      stagedCreateWorkflowSyncRef.current = {
        modifiedKey: "",
        originalKey: "",
        settingsKey: "",
      };
      workflow?.dispose().catch(() => undefined);
    },
    [],
  );

  const runCreate = async () => {
    if (busy) {
      abortActiveOperation();
      return;
    }
    if (completedOutput) {
      await completedOutput.saveAs();
      return;
    }
    if (!(original && modified)) return;
    const abortController = new AbortController();
    rememberAbortController(abortController);
    setBusy(true);
    setMessage("");
    setErrorCode("");
    disposeActiveOutput();
    clearCompletedOutput();
    setProgress(createIndeterminateWorkflowProgress({ label: "Creating patch...", role: "worker", stage: "create" }));
    const createWorkflow =
      stagedCreateWorkflowRef.current ||
      new CreateWorkflow({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: workflowIdRef.current,
        selectFile: async (request) =>
          createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
        settings: toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads),
        signal: abortController.signal,
      });
    const usingStagedWorkflow = stagedCreateWorkflowRef.current === createWorkflow;
    const handleProgress = createProgressHandler("create");
    createWorkflow.on("progress", handleProgress);
    const abortWorkflow = () => createWorkflow.abort(abortController.signal.reason);
    abortController.signal.addEventListener("abort", abortWorkflow, { once: true });
    try {
      if (usingStagedWorkflow) {
        await createWorkflow.setSettings(toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads));
      } else {
        await createWorkflow.setOriginal(toBrowserPublicBinarySource(original));
        await createWorkflow.setModified(toBrowserPublicBinarySource(modified));
      }
      await createWorkflow.setPatchType(patchType as NonNullable<CreateSettings["format"]>);
      await createWorkflow.setOutputName(executionOutputName);

      if (createWorkflow.getOriginal()?.status !== "ready" || !createWorkflow.getOriginal()?.selectedCandidateId) {
        throw new Error("Original source requires candidate selection");
      }
      if (createWorkflow.getModified()?.status !== "ready" || !createWorkflow.getModified()?.selectedCandidateId) {
        throw new Error("Modified source requires candidate selection");
      }

      const result = (await createWorkflow.run()) as BrowserCreateResult;
      rememberOutputDispose(result.output.dispose);
      setCompletedOutput({
        compression: createCompression,
        fileName: result.output.fileName,
        patchType,
        rawSize: result.sizeSummary?.rawSize,
        saveAs: result.output.saveAs,
        size: result.sizeSummary?.outputSize ?? result.output.size,
      });
      setProgress(null);
      if (typeof window !== "undefined") await result.output.saveAs();
      props.onCreateComplete?.(result);
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
      clearCompletedOutput();
      props.onError?.(normalizedError);
    } finally {
      abortController.signal.removeEventListener("abort", abortWorkflow);
      createWorkflow.off("progress", handleProgress);
      if (!usingStagedWorkflow) await createWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
      setBusy(false);
    }
  };

  useEffect(
    () => () => {
      abortActiveOperation();
      disposeActiveOutput();
    },
    [abortActiveOperation, disposeActiveOutput],
  );

  const progressProps = toWorkflowFileProgressProps(progress);
  const waitingProgressProps = toWorkflowFileProgressProps(createWaitingWorkflowProgress());
  const getSourceProgress = (role: "modified" | "original") => {
    if (stagingRole === role && progressProps && progress && !isChecksumProgress(progress)) return progressProps;
    const file = role === "original" ? original : modified;
    const sourceState = role === "original" ? originalState : modifiedState;
    return file && !sourceState && stagingRole ? waitingProgressProps : null;
  };
  const getSourceChecksumProgress = (role: "modified" | "original") =>
    stagingRole === role && progress && isChecksumProgress(progress) ? progress : null;
  const createCompressPanel = buildCompressPanel(createCompression, settings as Record<string, unknown>);

  const renderSourceStep = ({
    num,
    title,
    file,
    fileName,
    sourceState,
    emptyLabel,
    hint,
    replaceLabel,
    removeLabel,
    onSelect,
    onClear,
    sourceProgress = null,
    checksumProgress = null,
  }: {
    num: string;
    title: string;
    file: BinarySource | null;
    fileName: string;
    sourceState: CreateDisplaySourceState | null;
    hint: string;
    emptyLabel: string;
    replaceLabel: string;
    removeLabel: string;
    onSelect: (file: BinarySource | null) => void;
    onClear: () => void;
    sourceProgress?: typeof progressProps;
    checksumProgress?: WorkflowFormProgressState | null;
  }) => {
    const displayInfo = getDisplaySourceInfo(sourceState, fileName);
    const sourceChecksumProgress = isChecksumProgress(checksumProgress) ? checksumProgress : null;
    return (
      <WorkflowRomInputStep
        dropZone={{
          big: !file,
          disabled: uploadDisabled,
          hint: file ? undefined : hint,
          label: file ? replaceLabel : emptyLabel,
          onFiles: (files) => onSelect(files[0] ?? null),
        }}
        items={
          file
            ? [
                sourceProgress
                  ? {
                      id: `${num}:progress`,
                      progress: sourceProgress,
                    }
                  : {
                      card: {
                        extract: {
                          fileName,
                          fileSize: displayInfo?.size,
                          parentCompressions: displayInfo?.parentCompressions,
                          timing: formatElapsedMs(displayInfo?.decompressionTimeMs),
                        },
                        onRemove: onClear,
                        panels: {
                          fixes: {},
                          info: {
                            bytes: displayInfo?.size ?? displayInfo?.sourceSize,
                            checksums: getDisplaySourceChecksums(sourceState),
                            defaultOpen: false,
                            progress: toWorkflowChecksumProgressProps(sourceChecksumProgress),
                            timing: getChecksumTimingLabel(getDisplaySourceChecksumTiming(sourceState)) || undefined,
                          },
                        },
                        removeLabel,
                      },
                      id: `${num}:card`,
                    },
              ]
            : []
        }
        num={num}
        title={title}
      />
    );
  };

  return (
    <main aria-labelledby="tab-creator" className="panel" id="patch-builder-container">
      {renderSourceStep({
        checksumProgress: getSourceChecksumProgress("original"),
        emptyLabel: "Select original ROM · drop or browse",
        file: original,
        fileName: displayedOriginalFileName,
        hint: "the unmodified original · archives are extracted",
        num: "01",
        onClear: () => updateOriginal(null),
        onSelect: updateOriginal,
        removeLabel: "Clear original ROM",
        replaceLabel: "Replace original ROM · drop or browse",
        sourceProgress: getSourceProgress("original"),
        sourceState: originalState,
        title: "Original ROM",
      })}
      {renderSourceStep({
        checksumProgress: getSourceChecksumProgress("modified"),
        emptyLabel: "Select modified ROM · drop or browse",
        file: modified,
        fileName: displayedModifiedFileName,
        hint: "your edited / hacked ROM · archives are extracted",
        num: "02",
        onClear: () => updateModified(null),
        onSelect: updateModified,
        removeLabel: "Clear modified ROM",
        replaceLabel: "Replace modified ROM · drop or browse",
        sourceProgress: getSourceProgress("modified"),
        sourceState: modifiedState,
        title: "Modified ROM",
      })}
      <WorkflowOutputStep
        action={
          <OutputRunAction
            disabled={actionDisabled}
            download={completedOutput ? getCompletedDownloadMeta(completedOutput) : undefined}
            icon={
              completedOutput ? <Download aria-hidden="true" /> : busy ? undefined : <GitCompare aria-hidden="true" />
            }
            id="patch-builder-button-create"
            onClick={() => void runCreate()}
            progress={busy && progressProps && progress?.role !== "input" ? progressProps : null}
          >
            {busy ? "Cancel" : "CREATE & DOWNLOAD PATCH"}
          </OutputRunAction>
        }
        compress={buildOutputCompressionPanel({
          disabled,
          fields: createCompressPanel?.fields,
          format: getOutputCompressionFormatLabel(createCompression, createCompressionOptions),
          formatId: "patch-builder-select-output-compression",
          formatOptions: createCompressionOptions,
          formatValue: createCompression,
          onFieldChange: (key, value) => updateSettings({ ...settings, [key]: value }),
          onFormatChange: (value) =>
            updateSettings({
              ...settings,
              output: { ...settings.output, compression: value as "7z" | "none" | "zip" },
            }),
          summary: createCompression === "none" ? undefined : createCompressPanel?.summary,
        })}
        disabled={disabled}
        fileName={resolvedOutputName}
        fileNameId="patch-builder-output-file"
        fileNamePlaceholder="Patch filename"
        format={patchType}
        formatId="patch-builder-select-patch-type"
        formatOptions={patchFormatOptions}
        info={
          <InfoPopover title="Output options">
            <strong>Output</strong>
            <ul>
              <li>Set the filename without an extension — the format selector controls the patch type.</li>
              <li>BPS records source &amp; target checksums so applies can be verified.</li>
            </ul>
          </InfoPopover>
        }
        notice={
          message ? (
            <Notice id="patch-builder-row-error-message" level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}>
              {message}
            </Notice>
          ) : null
        }
        num="03"
        onFileNameChange={(value) => {
          setOutputName(value);
          updateSettings({
            ...settings,
            output: { ...settings.output, outputName: value.trim() || undefined },
          });
        }}
        onFormatChange={updatePatchType}
        title="Output"
      />
      {candidateSelectionDialog}
    </main>
  );
}

export { CreatePatchForm };
