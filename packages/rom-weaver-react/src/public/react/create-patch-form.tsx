import Download from "lucide-react/dist/esm/icons/download.js";
import GitCompare from "lucide-react/dist/esm/icons/git-compare.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import { resolveAutomaticSelection, selectionToArchiveEntry } from "../../lib/input/selection.ts";
import {
  ApplyWorkflow,
  type BrowserCreateResult,
  type BrowserSaveDestination,
  type CreateSettings,
  CreateWorkflow,
  type WorkflowProgress,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { createProgressViewModelFromEvent, formatByteSize } from "../../presentation/workflow-presentation.ts";
import type { ApplyWorkflowInputState } from "../../types/apply-workflow.ts";
import type { CreateWorkflowSourceState } from "../../types/create-workflow.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { ChecksumList, ChecksumRow } from "./components/ds/checksum-list.tsx";
import { CompressPanelBody } from "./components/ds/compress-panel.tsx";
import { ExtractionTree } from "./components/ds/extraction-tree.tsx";
import { FileProgress, Notice, RunButton } from "./components/ds/feedback.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "./components/ds/layout.tsx";
import { OutputCard } from "./components/ds/output-card.tsx";
import { buildCompressPanel } from "./compress-options.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  normalizeDefaultArchive,
  toApplyWorkflowSettings,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import {
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
  toStagedInputInfo,
} from "./workflow-adapters.ts";

const createWorkflowId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const mergeCreateSettings = (
  baseSettings: CreatePatchFormSettings | undefined,
  overrideSettings: CreatePatchFormSettings | undefined,
): CreatePatchFormSettings => {
  const merged = { ...(baseSettings || {}), ...(overrideSettings || {}) } as CreatePatchFormSettings;
  if (baseSettings?.output || overrideSettings?.output) {
    merged.output = {
      ...(baseSettings?.output || {}),
      ...(overrideSettings?.output || {}),
    };
  }
  return merged;
};

const createSettingsDependencyKey = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "function" ? "[function]" : entry));

const resolveCreateExecutionOutputName = (outputName: string, patchType: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, patchType || "bps");
};

const getCompletedDownloadMeta = (fileName: string, size?: number | null) => ({
  format: "Patch",
  name: fileName,
  size: typeof size === "number" && Number.isFinite(size) ? formatByteSize(size) : undefined,
});

type CreateDisplaySourceState = ApplyWorkflowInputState | CreateWorkflowSourceState;

const getDisplaySourceInfo = (source: CreateDisplaySourceState | null | undefined, fallback: string) =>
  toStagedInputInfo(source, fallback);

const formatElapsedMs = (elapsedMs: number | undefined) =>
  typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? `${Math.round(elapsedMs)} ms` : "";

const formatChecksumTiming = (elapsedMs: number | undefined) =>
  elapsedMs === 0 ? "from extract" : formatElapsedMs(elapsedMs);

const isApplyPreviewSource = (source: CreateDisplaySourceState | null | undefined): source is ApplyWorkflowInputState =>
  !!source && "checksums" in source;

const getDisplaySourceChecksums = (source: CreateDisplaySourceState | null | undefined) =>
  isApplyPreviewSource(source) ? source.checksums : undefined;

const getDisplaySourceChecksumTiming = (source: CreateDisplaySourceState | null | undefined) =>
  isApplyPreviewSource(source) ? formatChecksumTiming(source.checksumTimeMs) : "";

const getChecksumTimingLabel = (timing: string) => (timing ? `Checksum ${timing}` : "");
const isChecksumProgress = (progress: NonNullable<ReturnType<typeof createProgressViewModelFromEvent>> | null) =>
  !!progress && /checksum/i.test(`${progress.label} ${progress.message}`);

const toChecksumProgressProps = (progress: NonNullable<ReturnType<typeof createProgressViewModelFromEvent>>) => ({
  ...progress,
  label: /^checksum\b/i.test(progress.label) ? progress.label : `Checksum ${progress.label}`,
  message: /^checksum\b/i.test(progress.message) ? progress.message : `Checksum ${progress.message}`,
});

const toExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  parentCompressions:
    | Array<{
        fileName: string;
        sourceSize?: number;
        outputSize?: number;
        decompressionTimeMs?: number;
      }>
    | undefined,
) => {
  const levels = (parentCompressions || []).map((entry) => ({
    name: entry.fileName,
    sizeBytes: entry.sourceSize ?? entry.outputSize,
    sizeLabel:
      typeof (entry.sourceSize ?? entry.outputSize) === "number"
        ? formatByteSize(entry.sourceSize ?? entry.outputSize)
        : undefined,
    timing:
      typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)
        ? `${Math.round(entry.decompressionTimeMs)} ms`
        : undefined,
  }));
  const last = levels[levels.length - 1];
  if (!last || last.name !== fileName) {
    levels.push({
      name: fileName,
      sizeBytes: fileSize,
      sizeLabel: typeof fileSize === "number" ? formatByteSize(fileSize) : undefined,
      timing: undefined,
    });
  }
  return levels;
};

const SourceChecksums = ({
  progress,
  sourceState,
}: {
  progress: NonNullable<ReturnType<typeof createProgressViewModelFromEvent>> | null;
  sourceState: CreateDisplaySourceState | null;
}) => {
  const checksums = getDisplaySourceChecksums(sourceState);
  const bytes = sourceState?.size ?? sourceState?.sourceSize;
  const checksumProgress = isChecksumProgress(progress) ? progress : null;
  if (!(checksums || checksumProgress || typeof bytes === "number")) return null;
  return (
    <ChecksumList
      defaultOpen={false}
      label="Info"
      lead={checksumProgress ? <FileProgress {...toChecksumProgressProps(checksumProgress)} /> : undefined}
      timing={getChecksumTimingLabel(getDisplaySourceChecksumTiming(sourceState)) || undefined}
    >
      <ChecksumRow
        copyValue={typeof bytes === "number" ? String(Math.floor(bytes)) : ""}
        label="BYTES"
        value={typeof bytes === "number" ? String(Math.floor(bytes)) : ""}
      />
      <ChecksumRow label="CRC32" value={checksums?.crc32 || ""} />
      <ChecksumRow label="MD5" value={checksums?.md5 || ""} />
      <ChecksumRow label="SHA-1" value={checksums?.sha1 || ""} />
    </ChecksumList>
  );
};

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
    mergeCreateSettings(providerSettings, props.defaultSettings),
  );
  const [internalPatchType, setInternalPatchType] = useState(props.defaultPatchType || "bps");
  const [busy, setBusy] = useState(false);
  const [stagingRole, setStagingRole] = useState<"modified" | "original" | null>(null);
  const [message, setMessage] = useState("");
  const [originalState, setOriginalState] = useState<CreateDisplaySourceState | null>(null);
  const [modifiedState, setModifiedState] = useState<CreateDisplaySourceState | null>(null);
  const [completedOutput, setCompletedOutput] = useState<{
    fileName: string;
    saveAs: (destination?: BrowserSaveDestination) => Promise<void>;
    size?: number;
  } | null>(null);
  const [progress, setProgress] = useState<{
    dedupeKey: string;
    indeterminate: boolean;
    label: string;
    message: string;
    percent: number | null;
    role?: string;
    stage: string;
    timingText: string;
    visualPercent: number | null;
  } | null>(null);
  const [outputName, setOutputName] = useState("");
  const activeOutputDisposeRef = useRef<(() => Promise<void> | void) | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const stagingOriginalGenerationRef = useRef(0);
  const stagingModifiedGenerationRef = useRef(0);
  const workflowIdRef = useRef(createWorkflowId("react-create"));
  const selectedOriginalEntryRef = useRef<string | null>(null);
  const selectedModifiedEntryRef = useRef<string | null>(null);
  const [errorCode, setErrorCode] = useState("");
  const original = props.original === undefined ? internalOriginal : props.original;
  const modified = props.modified === undefined ? internalModified : props.modified;
  const settings = props.settings || internalSettings || providerSettings;
  const patchType = props.patchType || internalPatchType;
  const disabled = !!props.disabled || busy || !!stagingRole;
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
  const createCompressionOptions = [
    { label: `.${patchType}`, value: "none" },
    { label: ".zip", value: "zip" },
    { label: ".7z", value: "7z" },
  ];
  const createCompressionLabel = createCompressionOptions.find((option) => option.value === createCompression)?.label;
  const displayedOriginalFileName = displayedOriginalInfo?.fileName || originalFileName;
  const displayedModifiedFileName = displayedModifiedInfo?.fileName || modifiedFileName;
  const stagingSettingsKey = useMemo(
    () =>
      createSettingsDependencyKey({
        input: settings.input,
        language: (settings as { language?: string }).language,
        limits: settings.limits,
        loggingLevel: settings.logging?.level,
        workers: settings.workers,
        workerThreads: props.workerThreads,
      }),
    [props.workerThreads, settings],
  );
  const stagingSettings = useMemo(
    () =>
      toApplyWorkflowSettings(
        {
          input: settings.input,
          limits: settings.limits,
          logging: settings.logging,
          output: { compression: "none" },
          workers: settings.workers,
        } as never,
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
    setInternalSettings(mergeCreateSettings(providerSettings, props.defaultSettings));
  }, [props.defaultSettings, props.settings, providerSettings]);

  const disposeActiveOutput = useCallback(() => {
    const dispose = activeOutputDisposeRef.current;
    activeOutputDisposeRef.current = null;
    if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
  }, []);

  const updateOriginal = (file: BinarySource | null) => {
    disposeActiveOutput();
    setCompletedOutput(null);
    selectedOriginalEntryRef.current = null;
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
    setCompletedOutput(null);
    selectedModifiedEntryRef.current = null;
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
    setCompletedOutput(null);
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updatePatchType = (nextPatchType: string) => {
    disposeActiveOutput();
    setCompletedOutput(null);
    if (!props.patchType) setInternalPatchType(nextPatchType);
    props.onPatchTypeChange?.(nextPatchType);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const createSelectFileHandler = useCallback(
    (role: "modified" | "original") => async (request: Parameters<typeof selectFile>[0]) => {
      const preferredEntry = role === "original" ? selectedOriginalEntryRef.current : selectedModifiedEntryRef.current;
      if (preferredEntry) {
        const preferredCandidate = request.candidates.find(
          (candidate) =>
            candidate.selectable && selectionToArchiveEntry(request, { id: candidate.id }) === preferredEntry,
        );
        if (preferredCandidate) return { id: preferredCandidate.id };
      }
      const automaticSelection = resolveAutomaticSelection(request);
      if (automaticSelection) {
        const selectedEntry = selectionToArchiveEntry(request, automaticSelection);
        if (role === "original") selectedOriginalEntryRef.current = selectedEntry;
        else selectedModifiedEntryRef.current = selectedEntry;
        return automaticSelection;
      }
      const choice = await selectFile(request);
      const selectedEntry = selectionToArchiveEntry(request, choice);
      if (role === "original") selectedOriginalEntryRef.current = selectedEntry;
      else selectedModifiedEntryRef.current = selectedEntry;
      return choice;
    },
    [selectFile],
  );

  const stageSource = useCallback(
    async (role: "modified" | "original", source: BinarySource | null, generation: number) => {
      if (!source) {
        if (role === "original") setOriginalState(null);
        else setModifiedState(null);
        return;
      }
      const workflow = new ApplyWorkflow({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        id: `${workflowIdRef.current}:${role}:stage:${generation}`,
        selectFile: createSelectFileHandler(role),
        settings: stagingSettingsRef.current,
      });
      const handleProgress = (event: WorkflowProgress) => {
        props.onProgress?.(toReactProgressEvent(event));
        setProgress({
          ...createProgressViewModelFromEvent(event, { stage: event.stage || "input" }),
          role: typeof event.role === "string" ? event.role : undefined,
        });
      };
      workflow.on("progress", handleProgress);
      setStagingRole(role);
      try {
        await workflow.setInput([toBrowserPublicBinarySource(source)]);
        const state = workflow.getInput();
        if (
          (role === "original" ? stagingOriginalGenerationRef.current : stagingModifiedGenerationRef.current) !==
          generation
        )
          return;
        if (role === "original") setOriginalState(state);
        else setModifiedState(state);
        setProgress((current) => (current?.stage === "input" ? null : current));
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const code = getErrorCode(normalizedError);
        if (
          code === "WORKFLOW_SELECTION_SKIPPED" ||
          (role === "original" ? stagingOriginalGenerationRef.current : stagingModifiedGenerationRef.current) !==
            generation
        ) {
          return;
        }
        setErrorCode(code);
        setMessage(
          formatCodedErrorForDisplay(
            normalizedError,
            createBrowserLocalizer((settings as { language?: string }).language),
          ),
        );
        if (role === "original") setOriginalState(workflow.getInput());
        else setModifiedState(workflow.getInput());
        props.onError?.(normalizedError);
      } finally {
        workflow.off("progress", handleProgress);
        await workflow.dispose();
        if (
          (role === "original" ? stagingOriginalGenerationRef.current : stagingModifiedGenerationRef.current) ===
          generation
        ) {
          setStagingRole((current) => (current === role ? null : current));
          setProgress((current) => (current?.stage === "input" ? null : current));
        }
      }
    },
    [
      createSelectFileHandler,
      props.onError,
      props.onProgress,
      resolvedAssetBaseUrl,
      (settings as { language?: string }).language,
    ],
  );

  useEffect(() => {
    const generation = ++stagingOriginalGenerationRef.current;
    void stageSource("original", original, generation);
  }, [original, stageSource, stagingSettingsKey]);

  useEffect(() => {
    const generation = ++stagingModifiedGenerationRef.current;
    void stageSource("modified", modified, generation);
  }, [modified, stageSource, stagingSettingsKey]);

  const runCreate = async () => {
    if (busy) {
      activeAbortControllerRef.current?.abort();
      return;
    }
    if (completedOutput) {
      await completedOutput.saveAs();
      return;
    }
    if (!(original && modified)) return;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    setBusy(true);
    setMessage("");
    setErrorCode("");
    disposeActiveOutput();
    setCompletedOutput(null);
    setProgress({
      dedupeKey: "create:start",
      indeterminate: true,
      label: "Creating patch...",
      message: "Creating patch...",
      percent: null,
      role: "worker",
      stage: "create",
      timingText: "",
      visualPercent: null,
    });
    const createWorkflow = new CreateWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: workflowIdRef.current,
      selectFile: async (request) =>
        createSelectFileHandler(request.role === "modified" ? "modified" : "original")(request),
      settings: toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads),
      signal: abortController.signal,
    });
    const handleProgress = (event: WorkflowProgress) => {
      props.onProgress?.(toReactProgressEvent(event));
      setProgress({
        ...createProgressViewModelFromEvent(event, { stage: event.stage || "create" }),
        role: typeof event.role === "string" ? event.role : undefined,
      });
    };
    createWorkflow.on("progress", handleProgress);
    try {
      await createWorkflow.setOriginal(toBrowserPublicBinarySource(original));
      await createWorkflow.setModified(toBrowserPublicBinarySource(modified));
      await createWorkflow.setPatchType(patchType as NonNullable<CreateSettings["format"]>);
      await createWorkflow.setOutputName(executionOutputName);

      if (createWorkflow.getOriginal()?.status !== "ready" || !createWorkflow.getOriginal()?.selectedCandidateId) {
        throw new Error("Original source requires candidate selection");
      }
      if (createWorkflow.getModified()?.status !== "ready" || !createWorkflow.getModified()?.selectedCandidateId) {
        throw new Error("Modified source requires candidate selection");
      }

      const result = (await createWorkflow.run()) as BrowserCreateResult;
      activeOutputDisposeRef.current = result.output.dispose;
      setCompletedOutput({
        fileName: result.output.fileName,
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
      setCompletedOutput(null);
      props.onError?.(normalizedError);
    } finally {
      createWorkflow.off("progress", handleProgress);
      await createWorkflow.dispose();
      if (activeAbortControllerRef.current === abortController) activeAbortControllerRef.current = null;
      setBusy(false);
    }
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
  const getSourceProgress = (role: "modified" | "original") =>
    stagingRole === role && progressProps && progress && !isChecksumProgress(progress) ? progressProps : null;
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
    checksumProgress?: NonNullable<ReturnType<typeof createProgressViewModelFromEvent>> | null;
  }) => (
    <StepSection num={num} title={title}>
      {file ? (
        <FileCard
          name={
            <ExtractionTree
              levels={toExtractionLevels(
                fileName,
                sourceState?.size,
                getDisplaySourceInfo(sourceState, fileName)?.parentCompressions,
              )}
              timing={formatElapsedMs(getDisplaySourceInfo(sourceState, fileName)?.decompressionTimeMs)}
            />
          }
          onRemove={onClear}
          removeLabel={removeLabel}
        >
          {sourceProgress ? <FileProgress {...sourceProgress} /> : null}
          <SourceChecksums progress={checksumProgress} sourceState={sourceState} />
        </FileCard>
      ) : null}
      <DropZone
        big={!file}
        disabled={disabled}
        hint={file ? undefined : hint}
        label={file ? replaceLabel : emptyLabel}
        onFiles={(files) => onSelect(files[0] ?? null)}
      />
    </StepSection>
  );

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
      <StepSection
        info={
          <InfoPopover title="Output options">
            <strong>Output</strong>
            <ul>
              <li>Set the filename without an extension — the format selector controls the patch type.</li>
              <li>BPS records source &amp; target checksums so applies can be verified.</li>
            </ul>
          </InfoPopover>
        }
        num="03"
        title="Output"
      >
        <OutputCard
          action={
            <>
              {busy && progressProps && progress?.role !== "input" ? <FileProgress {...progressProps} /> : null}
              <RunButton
                disabled={actionDisabled}
                download={
                  completedOutput ? getCompletedDownloadMeta(completedOutput.fileName, completedOutput.size) : undefined
                }
                icon={
                  completedOutput ? (
                    <Download aria-hidden="true" />
                  ) : busy ? undefined : (
                    <GitCompare aria-hidden="true" />
                  )
                }
                id="patch-builder-button-create"
                onClick={() => void runCreate()}
              >
                {busy ? "Cancel" : "CREATE & DOWNLOAD PATCH"}
              </RunButton>
            </>
          }
          compress={{
            children: createCompressPanel ? (
              <CompressPanelBody
                disabled={disabled}
                fields={createCompressPanel.fields}
                onChange={(key, value) => updateSettings({ ...settings, [key]: value })}
              />
            ) : null,
            format: createCompression === "none" ? "None" : createCompressionLabel,
            formatId: "patch-builder-select-output-compression",
            formatLabel: "Type",
            formatOptions: createCompressionOptions,
            formatValue: createCompression,
            onFormatChange: (value) =>
              updateSettings({
                ...settings,
                output: { ...settings.output, compression: value as "7z" | "none" | "zip" },
              }),
            summary: createCompression === "none" ? undefined : createCompressPanel?.summary,
          }}
          disabled={disabled}
          fileName={resolvedOutputName}
          fileNameId="patch-builder-output-file"
          fileNamePlaceholder="Patch filename"
          format={patchType}
          formatId="patch-builder-select-patch-type"
          formatOptions={["aps", "bdf", "bps", "ebp", "ips", "pmsr", "ppf", "rup", "ups", "vcdiff", "xdelta"].map(
            (value) => ({ label: `.${value}`, value }),
          )}
          onFileNameChange={(value) => {
            setOutputName(value);
            updateSettings({
              ...settings,
              output: { ...settings.output, outputName: value.trim() || undefined },
            });
          }}
          onFormatChange={updatePatchType}
        />
        {message ? (
          <Notice id="patch-builder-row-error-message" level={errorCode === "AMBIGUOUS_SELECTION" ? "warn" : "error"}>
            {message}
          </Notice>
        ) : null}
      </StepSection>
      {candidateSelectionDialog}
    </main>
  );
}

export { CreatePatchForm };
