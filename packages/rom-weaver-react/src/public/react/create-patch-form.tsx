import { useCallback, useEffect, useRef, useState } from "react";
import { appendFileNameExtension, hasFileNameExtension } from "../../lib/input/path-utils.ts";
import {
  type BrowserCreateResult,
  type CreateSettings,
  CreateWorkflow,
  type WorkflowProgress,
} from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import { createProgressViewModelFromEvent } from "../../presentation/workflow-presentation.ts";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { ToolActionSection, ToolFileInputStack, ToolOutputFileRow } from "./components/tool-panel-sections.tsx";
import type { BinarySource } from "./patcher-form.ts";
import type { CandidateSelectionPrompt, CreatePatchFormProps, CreatePatchFormSettings } from "./public-types.ts";
import {
  getCreateSettingsOutputName,
  toCreateWorkflowSettings,
  useCreateSettings,
  useRomWeaverAssetBaseUrl,
} from "./settings-context.tsx";
import { formClasses, noticeClasses, rowClasses } from "./tailwind-classes";
import {
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toBrowserPublicBinarySource,
  toReactProgressEvent,
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

const resolveCreateExecutionOutputName = (outputName: string, patchType: string) => {
  const normalizedOutputName = outputName.trim();
  if (!normalizedOutputName) return normalizedOutputName;
  if (hasFileNameExtension(normalizedOutputName)) return normalizedOutputName;
  return appendFileNameExtension(normalizedOutputName, patchType || "bps");
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
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<{
    dedupeKey: string;
    indeterminate: boolean;
    label: string;
    message: string;
    percent: number | null;
    stage: string;
    timingText: string;
    visualPercent: number | null;
  } | null>(null);
  const [outputName, setOutputName] = useState("");
  const activeOutputDisposeRef = useRef<(() => Promise<void> | void) | null>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const workflowIdRef = useRef(createWorkflowId("react-create"));
  const selectedOriginalCandidateIdRef = useRef<string | null>(null);
  const selectedModifiedCandidateIdRef = useRef<string | null>(null);
  const [errorCode, setErrorCode] = useState("");
  const original = props.original === undefined ? internalOriginal : props.original;
  const modified = props.modified === undefined ? internalModified : props.modified;
  const settings = props.settings || internalSettings || providerSettings;
  const patchType = props.patchType || internalPatchType;
  const disabled = !!props.disabled || busy;
  const actionDisabled = !!props.disabled || !(busy || (original && modified));
  const configuredOutputName = getCreateSettingsOutputName(props.settings || props.defaultSettings || providerSettings);
  const generatedOutputName = configuredOutputName || getDefaultCreateOutputName(original);
  const resolvedOutputName = outputName.trim() || generatedOutputName;
  const executionOutputName = resolveCreateExecutionOutputName(resolvedOutputName, patchType);
  const originalFileName = getReactBinarySourceFileName(original, "Original ROM");
  const modifiedFileName = getReactBinarySourceFileName(modified, "Modified ROM");

  const disposeActiveOutput = useCallback(() => {
    const dispose = activeOutputDisposeRef.current;
    activeOutputDisposeRef.current = null;
    if (dispose) void Promise.resolve(dispose()).catch(() => undefined);
  }, []);

  const updateOriginal = (file: BinarySource | null) => {
    disposeActiveOutput();
    selectedOriginalCandidateIdRef.current = null;
    if (props.original === undefined) setInternalOriginal(file);
    props.onOriginalChange?.(file);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const updateModified = (file: BinarySource | null) => {
    disposeActiveOutput();
    selectedModifiedCandidateIdRef.current = null;
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
    if (!props.settings) setInternalSettings(nextSettings);
    props.onSettingsChange?.(nextSettings);
  };

  const updatePatchType = (nextPatchType: string) => {
    disposeActiveOutput();
    if (!props.patchType) setInternalPatchType(nextPatchType);
    props.onPatchTypeChange?.(nextPatchType);
    setMessage("");
    setErrorCode("");
    setProgress(null);
  };

  const runCreate = async () => {
    if (busy) {
      activeAbortControllerRef.current?.abort();
      return;
    }
    if (!(original && modified)) return;
    const abortController = new AbortController();
    activeAbortControllerRef.current = abortController;
    setBusy(true);
    setMessage("");
    setErrorCode("");
    disposeActiveOutput();
    setProgress({
      dedupeKey: "create:start",
      indeterminate: true,
      label: "Creating patch...",
      message: "Creating patch...",
      percent: null,
      stage: "create",
      timingText: "",
      visualPercent: null,
    });
    const createWorkflow = new CreateWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: workflowIdRef.current,
      selectFile: async (request) => {
        const preferredId =
          request.role === "original" ? selectedOriginalCandidateIdRef.current : selectedModifiedCandidateIdRef.current;
        const preferredCandidate = request.candidates.find((candidate) => candidate.id === preferredId);
        if (preferredCandidate?.selectable) return { id: preferredCandidate.id };
        return selectFile(request);
      },
      settings: toCreateWorkflowSettings(settings, executionOutputName, props.workerThreads),
      signal: abortController.signal,
    });
    const handleProgress = (event: WorkflowProgress) => {
      props.onProgress?.(toReactProgressEvent(event));
      setProgress(createProgressViewModelFromEvent(event, { stage: event.stage || "create" }));
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
      setProgress({
        dedupeKey: `create:complete:${result.output.fileName}`,
        indeterminate: false,
        label: `Created ${result.output.fileName}`,
        message: `Created ${result.output.fileName}`,
        percent: 100,
        stage: "create",
        timingText: "",
        visualPercent: 100,
      });
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

  return (
    <div
      aria-labelledby="tab-creator"
      className="font-['Inter_Tight','Segoe_UI',sans-serif]"
      id="patch-builder-container"
      role="tabpanel"
    >
      <ToolFileInputStack
        ariaLabel="Selected original ROM"
        disabled={disabled}
        emptyText="Choose original ROM"
        fileNames={originalFileName ? [originalFileName] : []}
        id="patch-builder-input-file-original"
        label="Original ROM"
        onChange={(event) => {
          updateOriginal(event.currentTarget.files?.[0] || null);
          event.currentTarget.value = "";
        }}
        onClear={() => updateOriginal(null)}
        progress={null}
      />
      <ToolFileInputStack
        ariaLabel="Selected modified ROM"
        disabled={disabled}
        emptyText="Choose modified ROM"
        fileNames={modifiedFileName ? [modifiedFileName] : []}
        id="patch-builder-input-file-modified"
        label="Modified ROM"
        onChange={(event) => {
          updateModified(event.currentTarget.files?.[0] || null);
          event.currentTarget.value = "";
        }}
        onClear={() => updateModified(null)}
        progress={null}
      />
      <ToolOutputFileRow
        disabled={disabled}
        id="patch-builder-output-file"
        label="Output file"
        onChange={(value) => {
          setOutputName(value);
          updateSettings({
            ...settings,
            output: {
              ...settings.output,
              outputName: value.trim() || undefined,
            },
          });
        }}
        outputControl={
          <select
            aria-label="Patch format"
            className={`${formClasses.select} w-[68px] flex-[0_0_68px] px-2 pr-4 text-left text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] disabled:opacity-100`}
            disabled={disabled}
            id="patch-builder-select-patch-type"
            onChange={(event) => updatePatchType(event.currentTarget.value)}
            title="Patch format"
            value={patchType}
          >
            {["aps", "bdf", "bps", "ebp", "ips", "pmsr", "ppf", "rup", "ups", "vcdiff", "xdelta"].map((value) => (
              <option key={value} value={value}>
                {value.toUpperCase()}
              </option>
            ))}
          </select>
        }
        value={resolvedOutputName}
      />
      <ToolActionSection
        actionId="patch-builder-button-create"
        actionLabel={busy ? "Cancel" : "Create patch"}
        disabled={actionDisabled}
        onAction={runCreate}
        progress={progress}
      />
      {message ? (
        <div
          aria-live="assertive"
          className={rowClasses.message}
          data-error-code={errorCode}
          id="patch-builder-row-error-message"
          role="alert"
        >
          <span
            className={`${noticeClasses.message} ${errorCode === "AMBIGUOUS_SELECTION" ? noticeClasses.warning : ""}`}
            id="patch-builder-error-message"
          >
            {message}
          </span>
        </div>
      ) : null}
      {candidateSelectionDialog}
    </div>
  );
}

export { CreatePatchForm };
