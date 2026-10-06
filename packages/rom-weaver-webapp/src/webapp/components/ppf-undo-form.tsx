import { Download, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { useFlatTransitionFlag } from "../../public/react/components/ds/flat-transition.ts";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { NeedsInput, StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { describeAgentSource, useAgentWorkflow } from "../agent/workflow-registry.ts";
import { usePpfUndoInputs } from "./ppf-undo-inputs.tsx";
import { isLikelyDiscImageSource } from "../../lib/compression/disc-image-policy.ts";
import { getFileNameExtension } from "../../lib/path-utils.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";
import { CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS } from "../../lib/compression/container-format-registry.ts";
import {
  useRomWeaverSettings,
  toApplyWorkflowSettings,
  getDefaultCompressionMode,
  getDefaultCompressionArchive,
} from "../../public/react/settings-context.tsx";
import { OutputCard } from "../../public/react/components/ds/output-card.tsx";
import { buildOutputCompressionPanel } from "../../public/react/components/ds/compress-panel.tsx";
import { buildCompressPanel } from "../../public/react/compress-options.ts";
import { createOutputOptions } from "../../public/react/output-view-model.ts";

const PPF_UNDO_ACTIVITY_KEY = "ppf-undo";

const restoredFileName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-restored` : `${name || "rom"}-restored`;
};

const StagedInputStep = ({
  file,
  label,
  noun,
  num,
  onAddInput,
  onRemove,
  title,
}: {
  file: File | null;
  label: string;
  noun: string;
  num: string;
  onAddInput: () => void;
  onRemove: () => void;
  title: string;
}) => (
  <StepSection num={num} title={title}>
    {file ? (
      <div className="cards">
        <FileCard
          meta={
            <>
              <span className="fsize mono">{formatByteSize(file.size)}</span>
              <span className="meta-fmt mono">{label}</span>
            </>
          }
          name={<span className="nm mono">{file.name}</span>}
          onRemove={onRemove}
          removeLabel={`Remove ${title.toLowerCase()}`}
        />
      </div>
    ) : (
      <NeedsInput onClick={onAddInput}>
        Waiting for {noun} - click here or the <b className="hexref mono">0x01</b> drop zone above to add one
      </NeedsInput>
    )}
  </StepSection>
);

type PpfUndoFormProps = {
  onSessionChange: (active: boolean) => void;
  pageDrop?: PageFileDrop | null;
};

const PpfUndoForm = ({ onSessionChange, pageDrop }: PpfUndoFormProps) => {
  const settings = useRomWeaverSettings();
  const defaultArchive = getDefaultCompressionArchive(getDefaultCompressionMode(settings));
  const [selectedCompression, setCompression] = useState<string>(defaultArchive || "none");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [rom, setRom] = useState<File | null>(null);
  const [patch, setPatch] = useState<File | null>(null);
  const [outputName, setOutputName] = useState("restored-rom");
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [error, setError] = useState("");
  const [runtimeWarnings, setRuntimeWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const outputRef = useRef<PublicOutput | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const handledDropRef = useRef(0);
  const workflowEmpty = useFlatTransitionFlag(!(rom || patch));

  useEffect(() => {
    outputRef.current = output;
  }, [output]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      void outputRef.current?.dispose();
      setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );
  useEffect(() => {
    onSessionChange(!!(rom || patch || output));
  }, [onSessionChange, output, patch, rom]);
  useEffect(() => {
    if (busy) setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { stage: "Restore original ROM", state: "running" });
    else if (error) setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { state: "failed" });
    else if (output) setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { stage: "Original ROM restored", state: "done" });
    else if (rom || patch) setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(PPF_UNDO_ACTIVITY_KEY, { state: "idle" });
  }, [busy, error, output, patch, rom]);

  const clearOutput = useCallback(() => {
    const previous = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    setError("");
    setRuntimeWarnings([]);
    if (previous) void previous.dispose();
  }, []);
  const selectRom = useCallback(
    (file: File) => {
      clearOutput();
      setRom(file);
      setOutputName(restoredFileName(file.name));
    },
    [clearOutput],
  );
  const selectPatch = useCallback(
    (file: File) => {
      clearOutput();
      setPatch(file);
    },
    [clearOutput],
  );
  const acceptInputs = useCallback(
    (droppedRom?: File | null, ppf?: File | null) => {
      if (droppedRom === null) setRom(null);
      if (ppf === null) setPatch(null);
      if (droppedRom) selectRom(droppedRom);
      if (ppf) selectPatch(ppf);
    },
    [selectPatch, selectRom],
  );
  const { stage, opening, warnings, dialog, release, getPrepared } = usePpfUndoInputs(acceptInputs, setError);
  useEffect(() => () => release(rom), [release, rom]);
  useEffect(() => () => release(patch), [release, patch]);
  const stageFiles = useCallback(
    (files: File[]) => {
      clearOutput();
      void stage(files);
    },
    [clearOutput, stage],
  );
  const ActionIcon = output ? Download : RotateCcw;
  const prepared = getPrepared(rom);
  const preparedRom = prepared?.output;
  const compressionSource = rom
    ? {
        fileName: preparedRom?.fileName || rom.name,
        size: rom.size,
        metadata: prepared?.metadata,
      }
    : null;
  const formats = [
    "none",
    "zip",
    "7z",
    ...CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS.filter(
      (format) =>
        OutputCompressionManager.supportsOutputCompression(compressionSource, format) &&
        (format !== "chd" ||
          !!compressionSource?.metadata?.cuePath ||
          isLikelyDiscImageSource(getFileNameExtension(compressionSource?.fileName || ""), compressionSource?.size)),
    ),
  ];
  const compression = formats.includes(selectedCompression) ? selectedCompression : "none";
  const activeSettings = { ...settings, ...overrides };
  const panel = buildCompressPanel(compression, activeSettings, compressionSource);

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    stageFiles(pageDrop.files);
  }, [pageDrop, stageFiles]);

  const canRun = !!(rom && patch && outputName.trim()) && !busy && !opening && !error && !output;
  const run = async () => {
    if (!(canRun && rom && patch)) return;
    clearOutput();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      const { undoPpf } = await import("../../platform/browser/browser-api.ts");
      const restored = await undoPpf({
        outputName: `${outputName.trim()}.${getFileNameExtension(preparedRom?.fileName || rom.name) || "bin"}`,
        onWarning: (message) => setRuntimeWarnings((previous) => [...previous, message]),
        compression,
        metadata: prepared?.metadata,
        settings: toApplyWorkflowSettings(activeSettings),
        patch,
        rom,
        target: prepared?.target,
        companions: prepared?.companions,
        preparedRom: preparedRom,
        preparedPatch: getPrepared(patch)?.output,
        signal: abort.signal,
      });
      outputRef.current = restored;
      setOutput(restored);
      await restored.saveAs();
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const download = async () => {
    if (!output) return;
    try {
      await output.saveAs({ fileName: output.fileName, interactive: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useAgentWorkflow("ppf-undo", {
    getState: () => ({
      rom: describeAgentSource(rom),
      patch: describeAgentSource(patch),
      busy,
      error: error || null,
      opening,
      options: { outputName, compression },
      output: output ? { fileName: output.fileName, size: output.size } : null,
    }),
    actions: {
      run: {
        description: "Restore the original ROM from the PPF undo data.",
        enabled: canRun,
        execute: () => void run(),
      },
      download: {
        description: "Download the restored ROM again.",
        enabled: !!output && !busy && !opening,
        execute: () => void download(),
      },
      cancel: {
        description: "Cancel the active PPF undo operation.",
        enabled: busy,
        execute: () => abortRef.current?.abort(),
      },
    },
  });

  return (
    <section className="panel" id="ppf-undo-container">
      {dialog}
      <UnifiedDropZone
        addLabel="Replace the patched ROM or PPF patch"
        big={workflowEmpty}
        disabled={busy || opening}
        guide={WORKFLOW_GUIDES.ppfUndo}
        heroLabel="Drop a patched ROM and PPF patch"
        heroLabelCoarse="Tap to add a patched ROM and PPF patch"
        info={<p>A PPF3 patch must include undo data to restore the original ROM.</p>}
        inputId="ppf-undo-input-picker"
        lead={{ line1: "ui.hero.toolsThesis", line2: "ui.hero.toolsThesis2", description: "ui.hero.toolsDescription" }}
        onFiles={stageFiles}
        supported={[
          { extensions: ["rom"], label: "Patched ROMs" },
          { extensions: ["ppf3"], label: "PPF3 patches" },
        ]}
      />
      {opening ? <p role="status">Opening ROM and patch inputs…</p> : null}
      {[...warnings, ...runtimeWarnings].map((warning) => (
        <Notice key={warning} level="warn">
          {warning}
        </Notice>
      ))}
      {workflowEmpty ? (
        <GhostSteps
          steps={[
            { num: "0x02", title: "Patched ROM" },
            { num: "0x03", title: "PPF patch" },
            { num: "0x04", title: "Restore" },
          ]}
        />
      ) : (
        <>
          <StagedInputStep
            file={rom}
            label="patched ROM"
            noun="a patched ROM"
            num="0x02"
            onAddInput={() => document.getElementById("ppf-undo-input-picker")?.click()}
            onRemove={() => {
              clearOutput();
              setRom(null);
            }}
            title="Patched ROM"
          />
          <StagedInputStep
            file={patch}
            label="PPF3"
            noun="a PPF patch"
            num="0x03"
            onAddInput={() => document.getElementById("ppf-undo-input-picker")?.click()}
            onRemove={() => {
              clearOutput();
              setPatch(null);
            }}
            title="PPF patch"
          />
          <StepSection fault={!!error} num="0x04" title="Restore" woven={!!output}>
            <OutputCard
              fileName={outputName}
              onFileNameChange={(value) => {
                clearOutput();
                setOutputName(value);
              }}
              format={compression}
              formatId="ppf-undo-output-compression"
              formatOptions={createOutputOptions(formats, compressionSource)}
              onFormatChange={(value) => {
                clearOutput();
                setCompression(value);
              }}
              disabled={busy || opening}
              compress={buildOutputCompressionPanel({
                disabled: busy || opening,
                fields: panel?.fields,
                note: panel?.note,
                onFieldChange: (key, value, updates) => {
                  clearOutput();
                  setOverrides((previous) => ({ ...previous, ...updates, [key]: value }));
                },
              })}
              action={
                <RunButton
                  disabled={busy || !(output || canRun)}
                  ariaLabel={output ? `Download ${output.fileName}` : undefined}
                  download={
                    output ? { format: "ROM", name: output.fileName, size: formatByteSize(output.size) } : undefined
                  }
                  icon={<ActionIcon aria-hidden="true" />}
                  onClick={() => void (output ? download() : run())}
                >
                  {busy ? "Restoring ROM…" : "Restore original ROM"}
                </RunButton>
              }
            />
            {error ? (
              <Notice level="error" onDismiss={() => setError("")}>
                {error}
              </Notice>
            ) : null}
          </StepSection>
        </>
      )}
    </section>
  );
};

export { PpfUndoForm };
export type { PpfUndoFormProps };
