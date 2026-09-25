import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { InlineProgress, Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { Modal } from "../../public/react/components/ds/modal.tsx";
import { SelectionCheckList, type SelectionItem, SelectionTree } from "../../public/react/components/ds/selection.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import type { ProgressEvent, PublicOutput } from "../../types/workflow-runtime-types.ts";

type ExtractFormProps = { pageDrop?: PageFileDrop | null };
type ProgressState = { label: string; percent: number | null };

const ONE_FILE_ERROR = "Add one file at a time.";
const outputPath = (output: PublicOutput): string => output.relativePath || output.fileName;
const isChd = (file: File): boolean => /\.chd$/i.test(file.name);
const binCount = (entries: { filename: string }[]): number =>
  entries.filter((entry) => /\.bin$/i.test(entry.filename)).length;
const zipName = (file: File): string => `${file.name.replace(/\.[^.]+$/, "") || "extracted"}.zip`;
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// Runtime labels are log text, so the form shows its own label and takes only the percent. An event
// without a percent keeps the last one for the same label, so the bar does not flicker to indeterminate.
const nextProgress = (previous: ProgressState | null, label: string, percent?: number | null): ProgressState => {
  if (typeof percent === "number") return { label, percent };
  return { label, percent: previous?.label === label ? previous.percent : null };
};

const percentText = (percent: number | null): string => (percent === null ? "" : `${Math.round(percent)}%`);

const isNestedExtract = (event: ProgressEvent): boolean =>
  typeof event.details === "object" &&
  event.details !== null &&
  "runtimeStage" in event.details &&
  event.details.runtimeStage === "nested-extract";

// The browser-storage path is the id because two archive entries can share one relative path.
const toSelectionItem = (output: PublicOutput): SelectionItem => {
  const path = outputPath(output);
  return {
    defaultSelected: true,
    id: output.path,
    name: path.split("/").join(" › "),
    selectable: true,
    sizeLabel: formatByteSize(output.size),
  };
};

const ExtractForm = ({ pageDrop }: ExtractFormProps) => {
  const [source, setSource] = useState<File | null>(null);
  const [outputs, setOutputs] = useState<PublicOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [zipProgress, setZipProgress] = useState<ProgressState | null>(null);
  const [splitPrompt, setSplitPrompt] = useState<File | null>(null);
  const [error, setError] = useState("");
  const outputRef = useRef<PublicOutput[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const zipAbortRef = useRef<AbortController | null>(null);
  // `saveAs` returns once the browser starts reading the file, so the last ZIP MUST stay in storage
  // until it is replaced; disposing it at once cancels a large download mid-transfer.
  const zipRef = useRef<PublicOutput | null>(null);
  const handledDropRef = useRef(0);
  const runIdRef = useRef(0);

  const disposeZip = useCallback(() => {
    const old = zipRef.current;
    zipRef.current = null;
    void old?.dispose();
  }, []);

  const clearOutputs = useCallback(() => {
    disposeZip();
    const old = outputRef.current;
    outputRef.current = [];
    setOutputs([]);
    void Promise.all(old.map((output) => output.dispose()));
  }, [disposeZip]);

  const extract = useCallback(
    async (file: File, splitBin: boolean) => {
      const runId = ++runIdRef.current;
      const abort = new AbortController();
      abortRef.current = abort;
      clearOutputs();
      setSplitPrompt(null);
      setBusy(true);
      setError("");
      const label = `Extracting ${file.name}…`;
      const nestedLabel = `Checking for archives inside ${file.name}…`;
      setProgress({ label, percent: null });
      try {
        const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
        const result = await browserRuntime.compression.extract?.({
          source: file,
          entries: [],
          extractAll: true,
          options: {
            chdSplitBin: splitBin,
            signal: abort.signal,
            onProgress: (event) => {
              if (runId !== runIdRef.current) return;
              const nested = isNestedExtract(event);
              setProgress((previous) => nextProgress(previous, nested ? nestedLabel : label, event.percent));
            },
          },
        });
        if (!result) throw new Error("Extraction is not available in this browser.");
        if (runId !== runIdRef.current) {
          await Promise.all(result.outputs.map((output) => output.dispose()));
          return;
        }
        outputRef.current = result.outputs;
        setOutputs(result.outputs);
      } catch (cause) {
        if (!abort.signal.aborted && runId === runIdRef.current) setError(errorMessage(cause));
      } finally {
        if (runId === runIdRef.current) {
          abortRef.current = null;
          setBusy(false);
          setProgress(null);
        }
      }
    },
    [clearOutputs],
  );

  // A multi-track CD CHD can extract as one BIN or as one BIN per track, so ask before extracting it.
  const startExtract = useCallback(
    async (file: File) => {
      if (!isChd(file)) {
        await extract(file, false);
        return;
      }
      const runId = ++runIdRef.current;
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      setError("");
      setProgress({ label: `Reading the tracks in ${file.name}…`, percent: null });
      let askSplit = false;
      try {
        const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
        const probe = browserRuntime.compression.probe;
        if (!probe) throw new Error("Reading files is not available in this browser.");
        const normal = await probe({ source: file, options: { signal: abort.signal } });
        const split = await probe({ source: file, options: { chdSplitBin: true, signal: abort.signal } });
        if (runId !== runIdRef.current) return;
        askSplit = binCount(split.entries) > 1 && binCount(split.entries) > binCount(normal.entries);
      } catch (cause) {
        if (!abort.signal.aborted && runId === runIdRef.current) setError(errorMessage(cause));
        return;
      } finally {
        if (runId === runIdRef.current) {
          abortRef.current = null;
          setBusy(false);
          setProgress(null);
        }
      }
      if (askSplit) setSplitPrompt(file);
      else await extract(file, false);
    },
    [extract],
  );

  const stageFiles = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      if (downloadBusy) {
        setError("Wait for the download to finish, then add the file again.");
        return;
      }
      runIdRef.current += 1;
      abortRef.current?.abort();
      clearOutputs();
      setSplitPrompt(null);
      setProgress(null);
      setSource(file);
      if (files.length > 1) {
        setError(ONE_FILE_ERROR);
        return;
      }
      void startExtract(file);
    },
    [clearOutputs, downloadBusy, startExtract],
  );

  useEffect(() => {
    if (!pageDrop || pageDrop.id === handledDropRef.current) return;
    handledDropRef.current = pageDrop.id;
    stageFiles(pageDrop.files);
  }, [pageDrop, stageFiles]);

  useEffect(
    () => () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      zipAbortRef.current?.abort();
      void zipRef.current?.dispose();
      void Promise.all(outputRef.current.map((output) => output.dispose()));
    },
    [],
  );

  const cancelSplitPrompt = () => {
    setSplitPrompt(null);
    setError("Extraction cancelled. Choose Extract again to pick a track layout.");
  };

  // One file downloads as itself; several download together as one uncompressed ZIP.
  const download = async (ids: string[]) => {
    if (!source || downloadBusy) return;
    const chosen = outputs.filter((output) => ids.includes(output.path));
    if (!chosen.length) return;
    setDownloadBusy(true);
    setError("");
    const abort = new AbortController();
    try {
      const [single] = chosen;
      if (chosen.length === 1 && single) {
        await single.saveAs({ fileName: single.fileName, interactive: true });
        return;
      }
      disposeZip();
      zipAbortRef.current = abort;
      const label = `Creating ${zipName(source)}…`;
      setZipProgress({ label, percent: null });
      const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
      const result = await browserRuntime.compression.create?.({
        entries: chosen.map((output) => ({ filePath: output.path, filename: outputPath(output) })),
        format: "zip",
        options: {
          onProgress: (event) => {
            if (!abort.signal.aborted) setZipProgress((previous) => nextProgress(previous, label, event.percent));
          },
          outputName: zipName(source),
          preservePaths: true,
          signal: abort.signal,
          zipCodec: "store",
        },
      });
      if (!result) throw new Error("ZIP downloads are not available in this browser.");
      const archive = "output" in result ? result.output : result;
      if (!archive) throw new Error("The ZIP file was not created.");
      zipRef.current = archive;
      setZipProgress(null);
      await archive.saveAs({ fileName: zipName(source), interactive: true });
    } catch (cause) {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    } finally {
      zipAbortRef.current = null;
      setZipProgress(null);
      setDownloadBusy(false);
    }
  };

  const canRetry = !(busy || outputs.length || splitPrompt) && error !== ONE_FILE_ERROR;
  const totalBytes = outputs.reduce((sum, output) => sum + output.size, 0);
  return (
    <section className="panel extract-tool" id="extract-container">
      <UnifiedDropZone
        addLabel="Replace the file"
        big={!source}
        disabled={busy || downloadBusy}
        heroLabel="Drop an archive or disc image to extract it"
        heroLabelCoarse="Tap to add an archive or disc image"
        info={<p>Extraction runs locally. Your files never leave this browser.</p>}
        inputId="extract-input-picker"
        lead={{
          line1: "ui.hero.extractThesis",
          line2: "ui.hero.extractThesis2",
          description: "ui.hero.extractDescription",
        }}
        multiple={false}
        onFiles={stageFiles}
        title="Archive"
      />
      {source ? (
        <StepSection
          meta={
            outputs.length ? (
              <>
                <span className="rb mono">{outputs.length === 1 ? "1 file" : `${outputs.length} files`}</span>
                <span className="rb mono">{formatByteSize(totalBytes)}</span>
              </>
            ) : undefined
          }
          num="0x02"
          title="Files"
          woven={outputs.length > 0}
        >
          {progress ? (
            <InlineProgress
              label={progress.label}
              percent={progress.percent}
              value={percentText(progress.percent)}
              onCancel={() => abortRef.current?.abort()}
            />
          ) : null}
          {outputs.length ? (
            <>
              <p className="pdesc">
                Select the files to download. Several files download together as one ZIP. The files stay in this browser
                until you add another file or leave this page.
              </p>
              {zipProgress ? (
                <InlineProgress
                  label={zipProgress.label}
                  percent={zipProgress.percent}
                  value={percentText(zipProgress.percent)}
                  onCancel={() => zipAbortRef.current?.abort()}
                />
              ) : null}
              <SelectionCheckList
                disabled={downloadBusy}
                items={outputs.map(toSelectionItem)}
                onSubmit={(ids) => void download(ids)}
                submitLabel={(count) => (count === 1 ? "Download 1 file" : `Download ${count} files as ZIP`)}
              />
            </>
          ) : null}
          {canRetry ? (
            <RunButton icon={<RotateCcw aria-hidden="true" />} onClick={() => void startExtract(source)}>
              Extract again
            </RunButton>
          ) : null}
        </StepSection>
      ) : (
        <GhostSteps steps={[{ num: "0x02", title: "Files" }]} />
      )}
      {error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      <Modal
        onClose={cancelSplitPrompt}
        open={!!splitPrompt}
        subtitle="This CHD holds a CD with more than one track. Choose how to write the tracks."
        title={splitPrompt?.name}
        variant="select-modal"
      >
        <SelectionTree
          items={[
            { id: "merged", name: "One BIN file", note: "All tracks in a single BIN file", selectable: true },
            {
              id: "split",
              name: "One BIN file per track",
              note: "A separate BIN file for each track",
              selectable: true,
            },
          ]}
          onSelect={(id) => {
            if (splitPrompt) void extract(splitPrompt, id === "split");
          }}
        />
      </Modal>
    </section>
  );
};

export { ExtractForm };
