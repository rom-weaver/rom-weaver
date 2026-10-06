import { Download, FileArchive } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { getFileNameWithoutExtension } from "../../lib/input/path-utils.ts";
import { createLogger } from "../../lib/logging.ts";
import { describeAgentSource, useAgentWorkflow } from "../agent/workflow-registry.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { buildOutputCompressionPanel } from "../../public/react/components/ds/compress-panel.tsx";
import { Notice } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { StageStatus, stageBarValue } from "../../public/react/components/ds/staging-meta.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import { OutputRunAction, WorkflowOutputStep } from "../../public/react/components/ds/workflow-output-step.tsx";
import { buildCompressPanel } from "../../public/react/compress-options.ts";
import { createOutputOptions } from "../../public/react/output-view-model.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import {
  getDefaultCompressionArchive,
  getDefaultCompressionMode,
  toApplyWorkflowSettings,
  useRomWeaverSettings,
  useUiLocalizer,
} from "../../public/react/settings-context.tsx";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import {
  compressFiles,
  type CompressSource,
  getCompressFormats,
  getCompressSource,
  isOpenableCompressInput,
} from "../compress-service.ts";
import { useCompressArchiveInputs } from "./compress-archive-inputs.tsx";

type CompressFormProps = { pageDrop?: PageFileDrop | null; onSessionChange?: (active: boolean) => void };
type CompressionFormat = Awaited<ReturnType<typeof getCompressFormats>>[number];
type InputInfo = { files: File[]; formats: CompressionFormat[]; source: CompressSource | null };
const logger = createLogger("compress-form");

const disposeOutput = (output: PublicOutput | null) => {
  void output?.dispose().catch((cause: unknown) => logger.warn("Output cleanup failed", { cause }));
};

const CompressForm = ({ pageDrop, onSessionChange }: CompressFormProps) => {
  const localizer = useUiLocalizer();
  const settings = useRomWeaverSettings();
  const [stagedFiles, setStagedFiles] = useState<Array<{ file: File; id: number; sourceName?: string }>>([]);
  const files = useMemo(() => stagedFiles.map((entry) => entry.file), [stagedFiles]);
  const nextFileId = useRef(0);
  const [inputInfo, setInputInfo] = useState<InputInfo | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>("");
  const [outputName, setOutputName] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent: number | null } | null>(null);
  const [error, setError] = useState("");
  const outputRef = useRef<PublicOutput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const handledDropRef = useRef(0);
  const nextId = useCallback(() => ++nextFileId.current, []);
  const addStaged = useCallback((entries: Array<{ file: File; id: number; sourceName?: string }>) => {
    if (entries.length) setStagedFiles((previous) => [...previous, ...entries]);
  }, []);
  const {
    cancel: cancelOpening,
    dialog: selectionDialog,
    open: openArchive,
    pending: pendingArchives,
    release: releaseArchiveEntry,
  } = useCompressArchiveInputs({ nextId, onAdd: addStaged, onError: setError });
  const opening = pendingArchives.length > 0;
  const staging = opening || (files.length > 0 && inputInfo?.files !== files);
  const disabled = busy || downloadBusy;
  const activeSettings = { ...settings, ...overrides };
  const formats = inputInfo?.files === files ? inputInfo.formats : [];
  const archiveDefault = getDefaultCompressionArchive(getDefaultCompressionMode(settings));
  const fallbackFormat = archiveDefault === "7z" ? "7z" : "zip";
  const format = formats.find((value) => value === selectedFormat) || fallbackFormat;
  const source = inputInfo?.files === files ? inputInfo.source : null;
  const formatOptions = createOutputOptions(formats, source);
  const panel = buildCompressPanel(format, activeSettings, source);
  // Entries from an opened archive are named after the archive rather than whichever entry came first.
  const generatedName = getFileNameWithoutExtension(stagedFiles[0]?.sourceName || files[0]?.name || "archive");
  const name = outputName || generatedName;
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);

  const clearOutput = useCallback(() => {
    disposeOutput(outputRef.current);
    outputRef.current = null;
    setOutput(null);
  }, []);

  const stageFiles = useCallback(
    (added: File[]) => {
      if (!added.length || disabled) return;
      clearOutput();
      setError("");
      addStaged(added.filter((file) => !isOpenableCompressInput(file)).map((file) => ({ file, id: nextId() })));
      for (const file of added.filter(isOpenableCompressInput)) void openArchive(file);
    },
    [addStaged, clearOutput, disabled, nextId, openArchive],
  );

  useEffect(() => {
    let current = true;
    if (!files.length) return;
    void Promise.all([getCompressSource(files), getCompressFormats(files)]).then(
      ([nextSource, nextFormats]) => {
        if (current) setInputInfo({ files, formats: nextFormats, source: nextSource });
      },
      (cause: unknown) => {
        if (!current) return;
        setInputInfo({ files, formats: ["zip", "7z"], source: null });
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [files]);

  useEffect(() => {
    if (!pageDrop || pageDrop.id === handledDropRef.current) return;
    handledDropRef.current = pageDrop.id;
    stageFiles(pageDrop.files);
  }, [pageDrop, stageFiles]);

  useEffect(() => {
    onSessionChange?.(files.length > 0 || opening || !!output);
  }, [files.length, onSessionChange, opening, output]);

  useEffect(() => {
    let state: "running" | "staging" | "failed" | "done" | "ready" | "idle" = "idle";
    if (busy || downloadBusy) state = "running";
    else if (staging) state = "staging";
    else if (error) state = "failed";
    else if (output) state = "done";
    else if (files.length) state = "ready";
    setWorkbenchActivity("compress-form", { state });
  }, [busy, downloadBusy, error, files.length, output, staging]);

  useEffect(
    () => () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      disposeOutput(outputRef.current);
      setWorkbenchActivity("compress-form", { state: "idle" });
    },
    [],
  );

  const run = async () => {
    if (disabled || staging || !files.length) return;
    const runId = ++runIdRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    clearOutput();
    setBusy(true);
    setProgress(null);
    setError("");
    try {
      const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
      const options = toApplyWorkflowSettings(activeSettings);
      const result = await compressFiles(
        files,
        {
          ...options,
          output: { ...options.output, compression: format, outputName: name },
          signal: abort.signal,
          onLog: options.logging?.sink,
          onProgress: (event) => {
            if (runId !== runIdRef.current || abort.signal.aborted) return;
            setProgress((previous) => ({
              label: event.label || previous?.label || "",
              percent: typeof event.percent === "number" ? event.percent : (previous?.percent ?? null),
            }));
          },
        },
        browserRuntime,
      );
      if (abort.signal.aborted || runId !== runIdRef.current) {
        await result.dispose();
        return;
      }
      outputRef.current = result;
      setOutput(result);
    } catch (cause) {
      if (!abort.signal.aborted && runId === runIdRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (runId === runIdRef.current) {
        abortRef.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  };

  const download = async () => {
    if (!output || disabled) return;
    const runId = runIdRef.current;
    setDownloadBusy(true);
    setError("");
    try {
      // The output MUST stay alive after saveAs returns while the browser reads the download.
      await output.saveAs({ fileName: output.fileName, interactive: true });
    } catch (cause) {
      if (runId === runIdRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (runId === runIdRef.current) setDownloadBusy(false);
    }
  };

  useAgentWorkflow("compress", {
    getState: () => ({
      sources: files.map(describeAgentSource),
      pendingArchives: pendingArchives.map(({ id, name: archiveName, percent, phase, size }) => ({
        id,
        name: archiveName,
        percent,
        phase,
        size,
      })),
      busy,
      downloadBusy,
      staging,
      progress,
      error: error || null,
      options: { format, outputName: name, overrides },
      output: output ? { id: output.path, fileName: output.fileName, size: output.size } : null,
    }),
    actions: {
      run: {
        description: "Compress the staged files with the current options.",
        enabled: !(disabled || staging) && files.length > 0,
        execute: run,
      },
      download: {
        description: "Download the compressed output.",
        enabled: !!output && !disabled,
        execute: download,
      },
      cancel: {
        description: "Cancel the active compression or archive opening.",
        enabled: busy || opening,
        execute: () => {
          if (busy) abortRef.current?.abort();
          for (const archive of pendingArchives) cancelOpening(archive.id);
        },
      },
    },
  });

  return (
    <section className="panel compress-tool" id="compress-container">
      <UnifiedDropZone
        addLabel={localizer.message("ui.drop.addFiles")}
        afterDropZone={
          stagedFiles.length || opening ? (
            <div className="cards compress-files">
              {stagedFiles.map(({ file, id }) => (
                <FileCard
                  key={id}
                  meta={<span className="fsize mono">{formatByteSize(file.size)}</span>}
                  name={<span className="nm mono">{file.name}</span>}
                  onRemove={
                    disabled
                      ? undefined
                      : () => {
                          clearOutput();
                          setError("");
                          releaseArchiveEntry(id);
                          setStagedFiles((previous) => previous.filter((entry) => entry.id !== id));
                        }
                  }
                  removeLabel={localizer.message("ui.compress.removeFile", { name: file.name })}
                />
              ))}
              {pendingArchives.map((archive) => (
                <FileCard
                  className="pending-card"
                  key={archive.id}
                  meta={
                    <>
                      <span className="fsize mono">{formatByteSize(archive.size)}</span>
                      <StageStatus
                        id={`compress-open-${archive.id}`}
                        label={localizer.message(
                          archive.phase === "reading" ? "ui.compress.reading" : "ui.compress.opening",
                        )}
                        percent={archive.percent}
                      />
                    </>
                  }
                  name={<span className="nm mono">{archive.name}</span>}
                  onRemove={() => cancelOpening(archive.id)}
                  removeLabel={localizer.message("ui.compress.removeFile", { name: archive.name })}
                  stageBar={stageBarValue(true, archive.percent)}
                />
              ))}
            </div>
          ) : null
        }
        big={!(files.length || opening)}
        disabled={disabled}
        guide={WORKFLOW_GUIDES.compress}
        heroLabel={localizer.message("ui.compress.drop")}
        heroLabelCoarse={localizer.message("ui.compress.tap")}
        info={<p>{localizer.message("ui.compress.local")}</p>}
        inputId="compress-input-picker"
        lead={{
          line1: "ui.hero.compressThesis",
          line2: "ui.hero.compressThesis2",
          description: "ui.hero.compressDescription",
        }}
        onFiles={stageFiles}
      />
      {files.length ? (
        <WorkflowOutputStep
          action={
            <OutputRunAction
              disabled={disabled || staging}
              download={output ? { name: output.fileName, size: formatByteSize(output.size) } : undefined}
              icon={output ? <Download aria-hidden="true" /> : <FileArchive aria-hidden="true" />}
              onClick={() => void (output ? download() : run())}
              progress={
                busy
                  ? {
                      label: progress?.label || localizer.message("ui.compress.running"),
                      percent: progress?.percent ?? null,
                      value: typeof progress?.percent === "number" ? `${Math.round(progress.percent)}%` : "",
                      onCancel: () => abortRef.current?.abort(),
                    }
                  : undefined
              }
            >
              {localizer.message("ui.compress.run")}
            </OutputRunAction>
          }
          compress={buildOutputCompressionPanel({
            disabled,
            fields: panel?.fields,
            note: panel?.note,
            onFieldChange: (key, value, updates) => {
              clearOutput();
              setOverrides((previous) => ({ ...previous, ...(updates || { [key]: value }) }));
            },
          })}
          disabled={disabled || staging}
          fileName={name}
          fileNameLabel={localizer.message("ui.apply.outputFilename")}
          format={format}
          formatOptions={formatOptions}
          meta={<span className="rb mono">{formatByteSize(totalSize)}</span>}
          num="0x02"
          onFileNameChange={(value) => {
            clearOutput();
            setOutputName(value);
          }}
          onFormatChange={(value) => {
            clearOutput();
            setSelectedFormat(value);
          }}
          title={localizer.message("ui.apply.outputOptions.output")}
          woven={!!output}
        />
      ) : (
        <GhostSteps steps={[{ num: "0x02", title: localizer.message("ui.apply.outputOptions.output") }]} />
      )}
      {error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      {selectionDialog}
    </section>
  );
};

export { CompressForm, type CompressFormProps };
