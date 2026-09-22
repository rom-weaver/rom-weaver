import { Download, FileArchive, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { InlineProgress, Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { Modal } from "../../public/react/components/ds/modal.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";

type ExtractFormProps = { pageDrop?: PageFileDrop | null };

const outputPath = (output: PublicOutput): string => output.relativePath || output.fileName;
const isChd = (file: File): boolean => /\.chd$/i.test(file.name);
const binCount = (entries: { filename: string }[]): number =>
  entries.filter((entry) => /\.bin$/i.test(entry.filename)).length;
const zipName = (file: File): string => `${file.name.replace(/\.[^.]+$/, "") || "extracted"}.zip`;

const ExtractForm = ({ pageDrop }: ExtractFormProps) => {
  const [source, setSource] = useState<File | null>(null);
  const [outputs, setOutputs] = useState<PublicOutput[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; percent?: number | null } | null>(null);
  const [splitPrompt, setSplitPrompt] = useState(false);
  const [error, setError] = useState("");
  const outputRef = useRef<PublicOutput[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const handledDropRef = useRef(0);
  const runIdRef = useRef(0);

  const clearOutputs = useCallback(() => {
    const old = outputRef.current;
    outputRef.current = [];
    setOutputs([]);
    setSelected(new Set());
    void Promise.all(old.map((output) => output.dispose()));
  }, []);

  const stageFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      if (downloadBusy) return;
      runIdRef.current += 1;
      abortRef.current?.abort();
      clearOutputs();
      setSplitPrompt(false);
      setProgress(null);
      setSource(files[0] || null);
      setError(files.length > 1 ? "Choose one container at a time." : "");
    },
    [clearOutputs, downloadBusy],
  );

  useEffect(() => {
    if (!pageDrop || pageDrop.id === handledDropRef.current) return;
    handledDropRef.current = pageDrop.id;
    stageFiles(pageDrop.files);
  }, [pageDrop, stageFiles]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      void Promise.all(outputRef.current.map((output) => output.dispose()));
    },
    [],
  );

  const extract = async (splitBin: boolean) => {
    if (!source || busy) return;
    const runId = ++runIdRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    clearOutputs();
    setSplitPrompt(false);
    setBusy(true);
    setError("");
    setProgress({ label: `Extracting ${source.name}…` });
    try {
      const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
      const result = await browserRuntime.compression.extract?.({
        source,
        entries: [],
        extractAll: true,
        options: {
          chdSplitBin: splitBin,
          signal: abort.signal,
          onProgress: (event) => {
            if (runId === runIdRef.current) setProgress({ label: event.label, percent: event.percent });
          },
        },
      });
      if (!result) throw new Error("The extract runtime is unavailable.");
      if (runId !== runIdRef.current) {
        await Promise.all(result.outputs.map((output) => output.dispose()));
        return;
      }
      outputRef.current = result.outputs;
      setOutputs(result.outputs);
      setSelected(new Set(result.outputs.map(outputPath)));
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

  const startExtract = async () => {
    if (!source || busy) return;
    if (!isChd(source)) {
      await extract(false);
      return;
    }
    const runId = ++runIdRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError("");
    setProgress({ label: `Checking ${source.name}…` });
    try {
      const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
      const probe = browserRuntime.compression.probe;
      if (!probe) throw new Error("The container probe is unavailable.");
      const normal = await probe({ source, options: { signal: abort.signal } });
      const split = await probe({ source, options: { chdSplitBin: true, signal: abort.signal } });
      if (runId !== runIdRef.current) return;
      if (binCount(split.entries) > 1 && binCount(split.entries) > binCount(normal.entries)) {
        setSplitPrompt(true);
        return;
      }
    } catch (cause) {
      if (!abort.signal.aborted && runId === runIdRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return;
    } finally {
      if (runId === runIdRef.current) {
        abortRef.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
    await extract(false);
  };

  const download = async (output: PublicOutput) => {
    try {
      setError("");
      await output.saveAs({ fileName: output.fileName, interactive: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const downloadZip = async (all: boolean) => {
    if (!source || downloadBusy) return;
    const chosen = all ? outputs : outputs.filter((output) => selected.has(outputPath(output)));
    if (!chosen.length) return;
    setDownloadBusy(true);
    setError("");
    let archive: PublicOutput | undefined;
    try {
      const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
      const result = await browserRuntime.compression.create?.({
        entries: chosen.map((output) => ({ filePath: output.path, filename: outputPath(output) })),
        format: "zip",
        options: { outputName: zipName(source), preservePaths: true, zipCodec: "store" },
      });
      if (!result) throw new Error("The ZIP runtime is unavailable.");
      archive = "output" in result ? result.output : result;
      if (!archive) throw new Error("ZIP creation returned no output.");
      await archive.saveAs({ fileName: zipName(source), interactive: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await archive?.dispose();
      setDownloadBusy(false);
    }
  };

  const selectedCount = outputs.filter((output) => selected.has(outputPath(output))).length;
  return (
    <section className="panel extract-tool" id="extract-container">
      <UnifiedDropZone
        addLabel="Replace container"
        big={!source}
        disabled={busy || downloadBusy}
        heroLabel="Drop a container to extract"
        heroLabelCoarse="Tap to add a container"
        inputId="extract-input-picker"
        lead={{ line1: "ui.hero.toolsThesis", line2: "ui.hero.toolsThesis2", description: "ui.hero.toolsDescription" }}
        multiple={false}
        onFiles={stageFiles}
        title="Container"
      />
      {source ? (
        <>
          <StepSection num="0x02" title="Extract" woven={outputs.length > 0}>
            <div className="card outcard extract-action-card">
              <div className="outbar">
                <span className="fname mono">{source.name}</span>
                <span className="mono">{formatByteSize(source.size)}</span>
              </div>
              {progress ? (
                <InlineProgress
                  label={progress.label}
                  percent={progress.percent}
                  onCancel={() => abortRef.current?.abort()}
                />
              ) : (
                <RunButton
                  disabled={busy || (!!error && error === "Choose one container at a time.")}
                  icon={<FileArchive aria-hidden="true" />}
                  onClick={() => void startExtract()}
                >
                  {outputs.length ? "Extract again" : "Extract all files"}
                </RunButton>
              )}
            </div>
          </StepSection>
          {outputs.length > 0 ? (
            <StepSection num="0x03" title="Download" woven>
              <p className="pdesc">
                Files remain in browser storage until you replace this container or leave the page.
              </p>
              <div className="extract-list">
                {outputs.map((output) => {
                  const path = outputPath(output);
                  return (
                    <div className="extract-row" key={path}>
                      <label className="extract-pick">
                        <input
                          checked={selected.has(path)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.currentTarget.checked) next.add(path);
                            else next.delete(path);
                            setSelected(next);
                          }}
                          type="checkbox"
                        />
                        <span className="mono" title={path}>
                          {path}
                        </span>
                      </label>
                      <span className="mono extract-size">{formatByteSize(output.size)}</span>
                      <button
                        aria-label={`Download ${path}`}
                        className="btn slim ghost"
                        onClick={() => void download(output)}
                        type="button"
                      >
                        <Download aria-hidden="true" /> Download
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="extract-actions">
                <button
                  className="btn ghost"
                  disabled={selectedCount === 0 || downloadBusy}
                  onClick={() => void downloadZip(false)}
                  type="button"
                >
                  <FileArchive aria-hidden="true" /> Download selected as ZIP ({selectedCount})
                </button>
                <button
                  className="btn primary"
                  disabled={downloadBusy}
                  onClick={() => void downloadZip(true)}
                  type="button"
                >
                  <Download aria-hidden="true" /> Download all as ZIP
                </button>
              </div>
            </StepSection>
          ) : null}
        </>
      ) : (
        <GhostSteps
          steps={[
            { num: "0x02", title: "Extract" },
            { num: "0x03", title: "Download" },
          ]}
        />
      )}
      {error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      <Modal open={splitPrompt} onClose={() => setSplitPrompt(false)} title="Extract a multi-track CD">
        <p>This CHD can produce one merged BIN or a separate BIN for each track.</p>
        <div className="extract-actions">
          <button className="btn ghost" onClick={() => setSplitPrompt(false)} type="button">
            <X aria-hidden="true" /> Cancel
          </button>
          <button className="btn ghost" onClick={() => void extract(false)} type="button">
            One merged BIN
          </button>
          <button className="btn primary" onClick={() => void extract(true)} type="button">
            Separate BINs
          </button>
        </div>
      </Modal>
    </section>
  );
};

export { ExtractForm };
