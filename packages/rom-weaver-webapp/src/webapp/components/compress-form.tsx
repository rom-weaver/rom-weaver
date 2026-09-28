import { Download, FileArchive } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { getFileNameWithoutExtension } from "../../lib/input/path-utils.ts";
import { createLogger } from "../../lib/logging.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { buildOutputCompressionPanel } from "../../public/react/components/ds/compress-panel.tsx";
import { Notice } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
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
import { compressFiles, type CompressSource, getCompressFormats, getCompressSource } from "../compress-service.ts";

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
  const [stagedFiles, setStagedFiles] = useState<Array<{ file: File; id: number }>>([]);
  const files = useMemo(() => stagedFiles.map((entry) => entry.file), [stagedFiles]);
  const nextFileId = useRef(0);
  const [inputInfo, setInputInfo] = useState<InputInfo | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>("");
  const [outputName, setOutputName] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const outputRef = useRef<PublicOutput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const handledDropRef = useRef(0);
  const staging = files.length > 0 && inputInfo?.files !== files;
  const disabled = busy || downloadBusy;
  const activeSettings = { ...settings, ...overrides };
  const formats = inputInfo?.files === files ? inputInfo.formats : [];
  const archiveDefault = getDefaultCompressionArchive(getDefaultCompressionMode(settings));
  const fallbackFormat = archiveDefault === "7z" ? "7z" : "zip";
  const format = formats.find((value) => value === selectedFormat) || fallbackFormat;
  const source = inputInfo?.files === files ? inputInfo.source : null;
  const formatOptions = createOutputOptions(formats, source);
  const panel = buildCompressPanel(format, activeSettings, source);
  const generatedName = getFileNameWithoutExtension(files[0]?.name || "archive");
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
      const entries = added.map((file) => ({ file, id: ++nextFileId.current }));
      setStagedFiles((previous) => [...previous, ...entries]);
    },
    [clearOutput, disabled],
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
    onSessionChange?.(files.length > 0 || !!output);
  }, [files.length, onSessionChange, output]);

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
    setPercent(null);
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
            if (runId === runIdRef.current && !abort.signal.aborted && typeof event.percent === "number")
              setPercent(event.percent);
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
        setPercent(null);
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

  return (
    <section className="panel compress-tool" id="compress-container">
      <UnifiedDropZone
        addLabel={localizer.message("ui.drop.addFiles")}
        afterDropZone={stagedFiles.map(({ file, id }) => (
          <FileCard
            key={id}
            meta={<span className="fsize mono">{formatByteSize(file.size)}</span>}
            name={file.name}
            onRemove={
              disabled
                ? undefined
                : () => {
                    clearOutput();
                    setError("");
                    setStagedFiles((previous) => previous.filter((entry) => entry.id !== id));
                  }
            }
            removeLabel={localizer.message("ui.compress.removeFile", { name: file.name })}
          />
        ))}
        big={!files.length}
        disabled={disabled}
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
                      label: localizer.message("ui.compress.running"),
                      percent,
                      value: percent === null ? "" : `${Math.round(percent)}%`,
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
            format: formatOptions.find((option) => option.value === format)?.label,
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
    </section>
  );
};

export { CompressForm, type CompressFormProps };
