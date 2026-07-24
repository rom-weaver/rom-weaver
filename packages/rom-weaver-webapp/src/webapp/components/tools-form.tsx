import { Download, RotateCcw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { undoPpf } from "../../platform/browser/browser-api.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { useFlatTransitionFlag } from "../../public/react/components/ds/flat-transition.ts";
import { NeedsInput, StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";

const TOOLS_ACTIVITY_KEY = "tools";

const restoredFileName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-restored${name.slice(dot)}` : `${name || "rom"}-restored`;
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

type ToolsFormProps = {
  onSessionChange: (active: boolean) => void;
  pageDrop?: PageFileDrop | null;
};

const ToolsForm = ({ onSessionChange, pageDrop }: ToolsFormProps) => {
  const [rom, setRom] = useState<File | null>(null);
  const [patch, setPatch] = useState<File | null>(null);
  const [outputName, setOutputName] = useState("restored-rom.bin");
  const [output, setOutput] = useState<PublicOutput | null>(null);
  const [error, setError] = useState("");
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
      setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );
  useEffect(() => {
    onSessionChange(!!(rom || patch || output));
  }, [onSessionChange, output, patch, rom]);
  useEffect(() => {
    if (busy) setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { stage: "Restore original ROM", state: "running" });
    else if (error) setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { state: "failed" });
    else if (output) setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { stage: "Original ROM restored", state: "done" });
    else if (rom || patch) setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(TOOLS_ACTIVITY_KEY, { state: "idle" });
  }, [busy, error, output, patch, rom]);

  const clearOutput = useCallback(() => {
    const previous = outputRef.current;
    outputRef.current = null;
    setOutput(null);
    setError("");
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
  const stageFiles = useCallback(
    (files: File[]) => {
      const ppf = [...files].reverse().find((file) => /\.ppf$/i.test(file.name));
      const droppedRom = [...files].reverse().find((file) => !/\.ppf$/i.test(file.name));
      if (droppedRom) selectRom(droppedRom);
      if (ppf) selectPatch(ppf);
    },
    [selectPatch, selectRom],
  );

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    stageFiles(pageDrop.files);
  }, [pageDrop, stageFiles]);

  const run = async () => {
    if (!(rom && patch && outputName.trim()) || busy) return;
    clearOutput();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    try {
      const restored = await undoPpf({
        outputName: outputName.trim(),
        patch,
        rom,
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

  return (
    <section className="panel" id="tools-container">
      <nav aria-label="Tool commands" className="tools-subnav">
        <div aria-orientation="horizontal" className="tools-subnav-rail" role="tablist">
          <button
            aria-controls="panel-tools-ppf-undo"
            aria-selected="true"
            className="tools-subnav-tab"
            id="tab-tools-ppf-undo"
            role="tab"
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            <span>PPF undo</span>
          </button>
        </div>
      </nav>
      <div aria-labelledby="tab-tools-ppf-undo" id="panel-tools-ppf-undo" role="tabpanel">
        <UnifiedDropZone
          addLabel="Replace the patched ROM or PPF patch"
          big={workflowEmpty}
          disabled={busy}
          heroLabel="Drop a patched ROM and PPF patch"
          heroLabelCoarse="Tap to add a patched ROM and PPF patch"
          info={<p>A PPF3 patch must include undo data to restore the original ROM.</p>}
          inputId="tools-input-picker"
          lead={{ line1: "ui.hero.toolsThesis", line2: "ui.hero.toolsThesis2" }}
          onFiles={stageFiles}
          supported={[
            { extensions: ["rom"], label: "Patched ROMs" },
            { extensions: ["ppf3"], label: "PPF3 patches" },
          ]}
        />
        <StagedInputStep
          file={rom}
          label="patched ROM"
          noun="a patched ROM"
          num="0x02"
          onAddInput={() => document.getElementById("tools-input-picker")?.click()}
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
          onAddInput={() => document.getElementById("tools-input-picker")?.click()}
          onRemove={() => {
            clearOutput();
            setPatch(null);
          }}
          title="PPF patch"
        />
        <StepSection fault={!!error} num="0x04" title="Restore" woven={!!output}>
          <div className="card outcard">
            <div className="outbar">
              <div className="fname fname-group">
                <textarea
                  aria-label="Output filename"
                  className="input mono outname"
                  disabled={busy}
                  onChange={(event) => {
                    clearOutput();
                    setOutputName(event.currentTarget.value.replace(/[\r\n]/g, ""));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                  }}
                  placeholder="Restored ROM filename"
                  rows={1}
                  spellCheck={false}
                  value={outputName}
                />
              </div>
            </div>
            {busy ? (
              <RunButton disabled icon={<RotateCcw aria-hidden="true" />}>
                Restoring ROM…
              </RunButton>
            ) : output ? (
              <RunButton
                ariaLabel={`Download ${output.fileName}`}
                download={{ format: "ROM", name: output.fileName, size: formatByteSize(output.size) }}
                icon={<Download aria-hidden="true" />}
                onClick={() => void download()}
              />
            ) : (
              <RunButton
                disabled={!(rom && patch && outputName.trim())}
                icon={<Wrench aria-hidden="true" />}
                onClick={() => void run()}
              >
                Restore original ROM
              </RunButton>
            )}
          </div>
          {error ? (
            <Notice level="error" onDismiss={() => setError("")}>
              {error}
            </Notice>
          ) : null}
        </StepSection>
      </div>
    </section>
  );
};

export { ToolsForm };
export type { ToolsFormProps };
