import { Hash } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getBaseFileName } from "../../lib/input/path-utils.ts";
import type {
  ChecksumWorkflowFile,
  ChecksumWorkflowSourceState,
} from "../../lib/workflow/checksum-workflow-controller.ts";
import { createLogger } from "../../lib/logging.ts";
import type { ChecksumWorkflow as BrowserChecksumWorkflow } from "../../platform/browser/browser-api.ts";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { useCandidateSelection } from "../../public/react/candidate-selection.tsx";
import { ChecksumList, ChecksumRow, PendingChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import { FileProgress, Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard, RemoveButton } from "../../public/react/components/ds/file-card.tsx";
import { DropZone, InfoPopover, StepSection } from "../../public/react/components/ds/layout.tsx";
import {
  StageStatus,
  stageBarValue,
  stagePercent,
  stageStatusLabel,
} from "../../public/react/components/ds/staging-meta.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { useInputSelectionHandler } from "../../public/react/input-selection-handler.ts";
import type {
  CandidateSelectionChoice,
  CandidateSelectionPrompt,
  PageFileDrop,
} from "../../public/react/public-types.ts";
import { useApplySettings, useRomWeaverAssetBaseUrl, useUiLocalizer } from "../../public/react/settings-context.tsx";
import { usePageDropForwarder, useWorkbenchActivity } from "../../public/react/workflow-form-effects.ts";
import {
  createReactWorkflowId,
  getSourceNoticeLevel,
  getSourceNoticeMessage,
  hasSourceQueueWarning,
} from "../../public/react/workflow-form-utils.ts";
import { loadBrowserApi } from "../../public/react/workflow-loader.ts";
import { describeAgentSource, useAgentWorkflow } from "../agent/workflow-registry.ts";
import {
  toWorkflowChecksumProgressProps,
  toWorkflowFileProgressProps,
  useWorkflowProgressState,
} from "../../public/react/workflow-run-hooks.ts";

const logger = createLogger("checksum-form");

/* Every algorithm the checksum engine supports (`rom-weaver formats`), with the
   hex length its digest has. Staging always computes the first three. */
const CHECKSUM_ALGORITHMS = [
  { hexLength: 8, id: "crc32", label: "CRC32" },
  { hexLength: 32, id: "md5", label: "MD5" },
  { hexLength: 40, id: "sha1", label: "SHA-1" },
  { hexLength: 64, id: "sha256", label: "SHA-256" },
  { hexLength: 64, id: "blake3", label: "BLAKE3" },
  { hexLength: 8, id: "crc32c", label: "CRC32C" },
  { hexLength: 4, id: "crc16", label: "CRC16" },
  { hexLength: 8, id: "adler32", label: "Adler-32" },
] as const;
const DEFAULT_ALGORITHMS = ["crc32", "md5", "sha1"];

type ChecksumFormProps = { pageDrop?: PageFileDrop | null };
type ChecksumSet = { checksums: Record<string, string>; id: string; label: string };
type ChecksumMatch = { algorithm: string; setId: string };
/** `match` is the first matching set; `matches` lists every set (file or variant) that equals the pasted value. */
type CompareResult = { match?: ChecksumMatch; matches?: ChecksumMatch[]; uncomputed: string[] } | null;

const normalizeChecksumInput = (raw: string) => raw.trim().toLowerCase().replace(/^0x/, "");

/* The raw file first, then its transform variants (headerless, byte-swapped…),
   each named so a match says which bytes it describes. */
const getChecksumSets = (file: ChecksumWorkflowFile, fileLabel: string): ChecksumSet[] => [
  { checksums: file.checksums, id: `${file.id}:raw`, label: fileLabel },
  ...(file.checksumVariants || [])
    .filter((variant) => variant.id !== "raw" && variant.id !== "manual")
    .map((variant) => ({
      checksums: variant.checksums as Record<string, string>,
      id: `${file.id}:${variant.id}`,
      label: fileLabel ? `${fileLabel} · ${variant.label}` : variant.label,
    })),
];

/* Compare one pasted digest against every computed set. Its length names the
   candidate algorithms; only switched-on ones match, since only they show a row.
   `uncomputed` lists the candidates still switched off or pending. */
const compareChecksum = (expected: string, sets: ChecksumSet[], algorithms: string[]): CompareResult => {
  if (!expected) return null;
  const candidates = CHECKSUM_ALGORITHMS.filter((algorithm) => algorithm.hexLength === expected.length);
  const matches = sets.flatMap((set) => {
    const algorithm = candidates.find((entry) => algorithms.includes(entry.id) && set.checksums[entry.id] === expected);
    return algorithm ? [{ algorithm: algorithm.id, setId: set.id }] : [];
  });
  const [match] = matches;
  if (match) return { match, matches, uncomputed: [] };
  const uncomputed = candidates
    .filter((entry) => !algorithms.includes(entry.id) || sets.some((set) => !set.checksums[entry.id]))
    .map((entry) => entry.label);
  return { uncomputed };
};

/* `bytes` renders right after CRC32, as the ROM card orders them, so the two
   short rows pair onto one grid row. Without CRC32 it leads the list. */
const ChecksumSetRows = ({
  algorithms,
  bytes,
  compare,
  expected,
  pending,
  set,
}: {
  algorithms: string[];
  bytes?: number;
  compare: CompareResult;
  expected: string;
  pending: boolean;
  set: ChecksumSet;
}) => (
  <>
    {bytes !== undefined && !algorithms.includes("crc32") ? <ChecksumRow label="BYTES" value={String(bytes)} /> : null}
    {CHECKSUM_ALGORITHMS.filter((algorithm) => algorithms.includes(algorithm.id)).map((algorithm) => {
      const value = set.checksums[algorithm.id] || "";
      const sameLength = expected.length === algorithm.hexLength;
      const matched = !!compare?.matches?.some((entry) => entry.setId === set.id && entry.algorithm === algorithm.id);
      const mark = matched ? "ok" : sameLength && !compare?.match ? "bad" : undefined;
      const row = value ? (
        <ChecksumRow
          className={algorithm.hexLength > 40 ? "ck-long" : undefined}
          label={algorithm.label}
          mark={mark}
          value={value}
        />
      ) : pending ? (
        <PendingChecksumRow
          className={algorithm.hexLength > 40 ? "ck-long" : undefined}
          label={algorithm.label}
          length={algorithm.hexLength}
        />
      ) : null;
      return (
        <Fragment key={algorithm.id}>
          {row}
          {algorithm.id === "crc32" && bytes !== undefined ? <ChecksumRow label="BYTES" value={String(bytes)} /> : null}
        </Fragment>
      );
    })}
  </>
);

type ChecksumSource = { file: File; id: number };

/* What one source reports upward. The parent owns the shared options and the
   comparison; each source owns its workflow, so files stage and hash side by
   side and the runner's scheduler decides how many are admitted at once. */
type ChecksumEntrySnapshot = {
  abort: () => void;
  calculate: () => Promise<void>;
  calculating: boolean;
  dismissError: () => void;
  error: string;
  files: ChecksumWorkflowFile[];
  id: number;
  input: ChecksumWorkflowSourceState | null;
  progress: ReturnType<typeof useWorkflowProgressState>["progress"];
  staging: boolean;
};

const ChecksumSourceEntry = ({
  algorithms,
  autoExtract,
  compare,
  expected,
  onSnapshot,
  onRequest,
  selectFile: selectAny,
  source,
}: {
  algorithms: string[];
  autoExtract: boolean;
  compare: CompareResult;
  expected: string;
  onSnapshot: (id: number, snapshot: ChecksumEntrySnapshot) => void;
  /** Reports which source asked for a selection, so skipping that prompt drops only that source. */
  onRequest: (request: CandidateSelectionPrompt, sourceId: number) => void;
  selectFile: (request: CandidateSelectionPrompt) => Promise<CandidateSelectionChoice>;
  source: ChecksumSource;
}) => {
  const localizer = useUiLocalizer();
  const settings = useApplySettings();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const [input, setInput] = useState<ChecksumWorkflowSourceState | null>(null);
  const [staging, setStaging] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState("");
  const algorithmsRef = useRef(algorithms);
  algorithmsRef.current = algorithms;
  const { clearProgressForStage, createProgressHandler, progress, setProgress } = useWorkflowProgressState({});
  const workflowRef = useRef<InstanceType<typeof BrowserChecksumWorkflow> | null>(null);
  const workflowIdRef = useRef(createReactWorkflowId("react-checksum"));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { file: sourceFile, id: sourceId } = source;
  const selectFile = useCallback(
    (request: CandidateSelectionPrompt) => {
      onRequest(request, sourceId);
      return selectAny(request);
    },
    [onRequest, selectAny, sourceId],
  );

  // A language or byte-unit change makes a new localizer; reading it through a
  // ref keeps showError stable so the staging effect does not restage the ROM.
  const localizerRef = useRef(localizer);
  localizerRef.current = localizer;
  const showError = useCallback(
    (cause: unknown) => setError(formatCodedErrorForDisplay(cause, localizerRef.current)),
    [],
  );

  // One workflow per staged file: leaving disposes it, which releases its extracted files.
  useEffect(() => {
    setInput(null);
    let current = true;
    let workflow: InstanceType<typeof BrowserChecksumWorkflow> | null = null;
    const handleProgress = createProgressHandler("input");
    void (async () => {
      const { ChecksumWorkflow } = await loadBrowserApi();
      if (!current) return;
      const { input: inputSettings, logging, workers } = settingsRef.current;
      workflow = new ChecksumWorkflow({
        ...(assetBaseUrl ? { assetBaseUrl } : {}),
        id: workflowIdRef.current,
        selectFile,
        settings: { input: inputSettings, logging, workers },
      });
      workflowRef.current = workflow;
      workflow.on("progress", handleProgress);
      setStaging(true);
      logger.debug("staging ROM", { fileName: sourceFile.name, size: sourceFile.size });
      try {
        await workflow.setInput(sourceFile, { algorithms: algorithmsRef.current, autoExtract });
        if (current) setInput(workflow.getInput());
      } catch (cause) {
        if (!current) return;
        setInput(workflow.getInput());
        const code = getErrorCode(cause);
        logger.debug("staging failed", { code, fileName: sourceFile.name });
        if (code !== "WORKFLOW_SELECTION_SKIPPED" && code !== "CANCELLED") showError(cause);
      } finally {
        workflow.off("progress", handleProgress);
        if (current) {
          setStaging(false);
          clearProgressForStage("input");
        }
      }
    })();
    return () => {
      current = false;
      workflow?.off("progress", handleProgress);
      if (workflowRef.current === workflow) workflowRef.current = null;
      void workflow?.dispose().catch(() => undefined);
    };
  }, [assetBaseUrl, autoExtract, clearProgressForStage, createProgressHandler, selectFile, showError, sourceFile]);

  // Ids are scoped to the source so two files that both name their entry "input" never collide.
  const files = useMemo(
    () => (input?.status === "ready" ? input.files.map((file) => ({ ...file, id: `${sourceId}:${file.id}` })) : []),
    [input, sourceId],
  );
  const missing = algorithms.filter((algorithm) => !files.length || files.some((file) => !file.checksums[algorithm]));

  const calculate = async () => {
    const workflow = workflowRef.current;
    if (!(workflow && missing.length) || calculating) return;
    setCalculating(true);
    setError("");
    const handleProgress = createProgressHandler("checksum");
    workflow.on("progress", handleProgress);
    try {
      const next = await workflow.calculate(algorithms);
      if (workflowRef.current === workflow) setInput(next);
    } catch (cause) {
      if (workflowRef.current === workflow) {
        setInput(workflow.getInput());
        if (getErrorCode(cause) !== "CANCELLED") showError(cause);
      }
    } finally {
      workflow.off("progress", handleProgress);
      if (workflowRef.current === workflow) {
        setCalculating(false);
        setProgress(null);
      }
    }
  };
  const calculateRef = useRef(calculate);
  calculateRef.current = calculate;
  const handle = useMemo(
    () => ({
      abort: () => workflowRef.current?.abort(),
      calculate: () => calculateRef.current(),
      dismissError: () => setError(""),
    }),
    [],
  );

  // Layout timing, so the parent's totals never lag the cards by a painted frame.
  useLayoutEffect(() => {
    onSnapshot(sourceId, { ...handle, calculating, error, files, id: sourceId, input, progress, staging });
  }, [calculating, error, files, handle, input, onSnapshot, progress, sourceId, staging]);

  const stagingChecksum = staging && progress?.stage === "checksum";
  const stagingProgress = stagingChecksum
    ? toWorkflowChecksumProgressProps(progress)
    : toWorkflowFileProgressProps(staging ? progress : null);
  const stagePct = stagePercent(stagingProgress);
  const displayedFiles: ChecksumWorkflowFile[] = files.length
    ? files
    : [
        {
          checksums: {},
          fileName: input?.fileName || sourceFile.name,
          id: "input",
          size: input?.size ?? sourceFile.size,
        },
      ];

  return (
    <>
      {displayedFiles.map((file) => (
        <FileCard
          key={file.id}
          meta={
            <>
              <span className="fsize mono">{formatByteSize(file.size)}</span>
              {staging ? (
                <StageStatus
                  id="checksum-input-stage"
                  label={stageStatusLabel("Checksumming", !stagingChecksum, localizer)}
                  percent={stagePct}
                />
              ) : null}
            </>
          }
          name={
            <span className="nm" title={file.fileName}>
              {getBaseFileName(file.fileName)}
            </span>
          }
          stageBar={stageBarValue(staging, stagePct)}
          state={hasSourceQueueWarning(input) ? "bad" : undefined}
        >
          {files.length ? (
            <ChecksumList defaultOpen label={localizer.message("ui.checks.title")}>
              {getChecksumSets(file, "").map((set) => {
                const rows = (
                  <ChecksumSetRows
                    algorithms={algorithms}
                    {...(set.label ? {} : { bytes: file.size })}
                    compare={compare}
                    expected={expected}
                    key={set.id}
                    pending={calculating}
                    set={set}
                  />
                );
                return set.label ? (
                  <div className="ck-group" key={set.id}>
                    <div className="ck-group-head">{set.label}</div>
                    {rows}
                  </div>
                ) : (
                  rows
                );
              })}
            </ChecksumList>
          ) : null}
        </FileCard>
      ))}
    </>
  );
};

const ChecksumForm = ({ pageDrop }: ChecksumFormProps) => {
  const localizer = useUiLocalizer();
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    fileInput: true,
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  // Matches webapp-root's `currentView` so root routing targets this tab's dialog.
  useInputSelectionHandler("checksum", selectFile);
  const [sources, setSources] = useState<ChecksumSource[]>([]);
  const [snapshots, setSnapshots] = useState<Record<number, ChecksumEntrySnapshot>>({});
  const [algorithms, setAlgorithms] = useState<string[]>(DEFAULT_ALGORITHMS);
  const [expectedText, setExpectedText] = useState("");
  const [autoExtract, setAutoExtract] = useState(true);
  const workflowIdRef = useRef(createReactWorkflowId("react-checksum"));
  const handledPageDropIdRef = useRef<number | null>(null);
  const nextSourceIdRef = useRef(0);
  const requestSourcesRef = useRef(new WeakMap<CandidateSelectionPrompt, number>());
  const recordRequest = useCallback(
    (request: CandidateSelectionPrompt, sourceId: number) => requestSourcesRef.current.set(request, sourceId),
    [],
  );

  const reportSnapshot = useCallback(
    (id: number, snapshot: ChecksumEntrySnapshot) => setSnapshots((previous) => ({ ...previous, [id]: snapshot })),
    [],
  );

  // Every dropped or picked file gets its own result, like `sha256sum a b c`; a new set replaces the old one.
  const handleDrop = (dropped: File[]) => {
    if (!dropped.length) return;
    setSnapshots({});
    setSources(
      dropped.map((file) => {
        nextSourceIdRef.current += 1;
        return { file, id: nextSourceIdRef.current };
      }),
    );
  };
  usePageDropForwarder(pageDrop, handleDrop, handledPageDropIdRef);

  const clearSources = () => {
    setSnapshots({});
    setSources([]);
  };

  // A skipped selection drops only the archive it was asked about.
  cancelSelectionRef.current = (request) => {
    if (request.sourceIndex === -1) return;
    const id = requestSourcesRef.current.get(request);
    if (id !== undefined) setSources((previous) => previous.filter((entry) => entry.id !== id));
    else if (sources.length === 1) clearSources();
  };

  const entries = sources.flatMap((entry) => {
    const snapshot = snapshots[entry.id];
    return snapshot ? [snapshot] : [];
  });
  const files = entries.flatMap((entry) => entry.files);
  const staging = entries.some((entry) => entry.staging);
  const calculating = entries.some((entry) => entry.calculating);
  const errors = entries.filter((entry) => entry.error);
  const missing = algorithms.filter(
    (algorithm) =>
      sources.length > 0 &&
      (entries.length < sources.length || !files.length || files.some((file) => !file.checksums[algorithm])),
  );
  const sourceWarning = entries.some((entry) => hasSourceQueueWarning(entry.input));

  const calculate = async () => {
    if (calculating) return;
    await Promise.all(entries.map((entry) => entry.calculate()));
  };
  const abortAll = () => {
    for (const entry of entries) entry.abort();
  };

  const toggleAlgorithm = (algorithm: string, on: boolean) =>
    setAlgorithms((previous) => (on ? [...previous, algorithm] : previous.filter((entry) => entry !== algorithm)));

  useWorkbenchActivity(workflowIdRef.current, {
    busy: staging || calculating,
    completed: files.length > 0,
    queued: false,
  });

  const expected = normalizeChecksumInput(expectedText);
  const expectedInvalid = !!expected && !/^[0-9a-f]+$/.test(expected);
  const multiFile = files.length > 1;
  const sets = files.flatMap((file) => getChecksumSets(file, multiFile ? file.fileName : ""));
  const compare = expectedInvalid ? null : compareChecksum(expected, sets, algorithms);
  const matchedSets = sets.filter((set) => compare?.matches?.some((entry) => entry.setId === set.id));
  const matchedLabel = CHECKSUM_ALGORITHMS.find((entry) => entry.id === compare?.match?.algorithm)?.label;
  const matchedNames = matchedSets.map((set) => set.label);
  const matchedText =
    matchedNames.length > 3
      ? `${matchedNames.slice(0, 2).join(", ")} and ${matchedNames.length - 2} other files`
      : matchedNames.join(", ");
  const activeProgress = entries.find((entry) => entry.calculating)?.progress ?? null;
  const notices = entries.flatMap((entry, index) => {
    const message = getSourceNoticeMessage(entry.input);
    return message
      ? [{ index, level: getSourceNoticeLevel(entry.input) as ReturnType<typeof getSourceNoticeLevel>, message }]
      : [];
  });
  const sourceEmpty = sources.length === 0;
  const single = sources.length === 1 ? sources[0] : undefined;

  useAgentWorkflow("checksum", {
    getState: () => ({
      source: single ? describeAgentSource(single.file) : null,
      staging,
      calculating,
      progress: entries.find((entry) => entry.progress)?.progress ?? null,
      error: errors[0]?.error || null,
      options: { algorithms, autoExtract, expectedChecksum: expectedText },
      missingAlgorithms: missing,
      results: files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        size: file.size,
        checksums: file.checksums,
        checksumVariants: file.checksumVariants?.map((variant) => ({
          id: variant.id,
          label: variant.label,
          checksums: variant.checksums,
        })),
      })),
      comparison: compare,
      sourceStatus: entries.length === 1 ? entries[0]?.input?.status || null : null,
      sourceNotice: notices[0]?.message || null,
    }),
    actions: {
      run: {
        description: "Calculate the selected missing checksums.",
        enabled: entries.length > 0 && missing.length > 0 && !calculating && !staging,
        execute: calculate,
      },
      cancel: {
        description: "Cancel staging or checksum calculation.",
        enabled: staging || calculating,
        execute: abortAll,
      },
    },
  });

  return (
    <section className="panel checksum-tool" id="checksum-container">
      {!sourceEmpty && <h1 className="sr-only">{localizer.message("ui.hero.checksumThesis")}</h1>}
      {sourceEmpty ? (
        <UnifiedDropZone
          addLabel="Replace the file"
          big={sourceEmpty}
          disabled={calculating}
          heroLabel="Drop a file to checksum it"
          heroLabelCoarse="Tap to add a file"
          info={<p>Checksums are calculated locally. Your files never leave this browser.</p>}
          inputId="checksum-input-picker"
          lead={{
            line1: "ui.hero.checksumThesis",
            line2: "ui.hero.checksumThesis2",
            description: "ui.hero.checksumDescription",
          }}
          onFiles={handleDrop}
          title="Input"
        />
      ) : (
        <StepSection
          fault={sourceWarning || (errors.length > 0 && !files.length)}
          id="checksum-source"
          info={
            <InfoPopover title="File input">
              <ul>
                <li>When Auto extract is on, choose a file if an archive contains several.</li>
                <li>Turn Auto extract off to checksum an archive without opening it.</li>
              </ul>
            </InfoPopover>
          }
          num="0x01"
          title="Input"
          woven={files.length > 0}
        >
          <DropZone
            disabled={calculating}
            inputId="checksum-input-picker"
            label="Replace the file"
            onFiles={handleDrop}
          />
        </StepSection>
      )}
      <StepSection
        headerExtra={
          <div className="checksum-extract">
            <label className="panel-view-toggle">
              <input
                checked={autoExtract}
                disabled={calculating || staging}
                id="checksum-auto-extract"
                onChange={(event) => setAutoExtract(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>Auto extract</span>
            </label>
            <InfoPopover title="About Auto extract">
              <p>Open archives and containers before calculating checksums. Turn off to checksum the original file.</p>
            </InfoPopover>
          </div>
        }
        id="checksum-options"
        num="0x02"
        title={localizer.message("ui.output.options")}
      >
        <fieldset className="checksum-algos" disabled={calculating || staging}>
          <legend>Checksums to calculate</legend>
          <div className="checksum-algo-grid">
            {CHECKSUM_ALGORITHMS.map((algorithm) => (
              <label className="checksum-algo" key={algorithm.id}>
                <input
                  checked={algorithms.includes(algorithm.id)}
                  id={`checksum-algo-${algorithm.id}`}
                  onChange={(event) => toggleAlgorithm(algorithm.id, event.currentTarget.checked)}
                  type="checkbox"
                />
                <span>{algorithm.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </StepSection>
      {sourceEmpty ? null : (
        <StepSection
          className="checksum-results"
          fault={!!compare && !compare.match && !compare.uncomputed.length}
          headerExtra={<RemoveButton label={multiFile ? "Remove files" : "Remove file"} onClick={clearSources} />}
          id="checksum-results"
          info={
            <InfoPopover title="Checksums">
              <ul>
                <li>Switch on an algorithm, then calculate it. Click a value to copy it.</li>
                <li>Paste an expected checksum to compare it with every computed value.</li>
                <li>Headerless and other variants appear when the ROM has a known header or byte order.</li>
              </ul>
            </InfoPopover>
          }
          num="0x03"
          title="Checksums"
          woven={!!compare?.match}
        >
          {!staging && missing.length ? (
            calculating ? (
              <FileProgress
                {...(toWorkflowChecksumProgressProps(activeProgress) || { indeterminate: true, label: "Checksum" })}
                cancelLabel="Cancel checksum"
                id="checksum-calculate-progress"
                onCancel={abortAll}
              />
            ) : (
              <RunButton icon={<Hash aria-hidden="true" />} id="checksum-calculate" onClick={() => void calculate()}>
                {`Calculate ${missing
                  .map((algorithm) => CHECKSUM_ALGORITHMS.find((entry) => entry.id === algorithm)?.label)
                  .join(", ")}`}
              </RunButton>
            )
          ) : null}
          <div className="cards workflow-file-list">
            {sources.map((entry) => (
              <ChecksumSourceEntry
                algorithms={algorithms}
                autoExtract={autoExtract}
                compare={compare}
                expected={expected}
                key={entry.id}
                onRequest={recordRequest}
                onSnapshot={reportSnapshot}
                selectFile={selectFile}
                source={entry}
              />
            ))}
          </div>
          {notices.map((notice) => (
            <Notice id={notice.index ? undefined : "checksum-source-notice"} key={notice.index} level={notice.level}>
              {notice.message}
            </Notice>
          ))}
          <label className="checksum-compare" htmlFor="checksum-compare-input">
            <span>Compare with an expected checksum</span>
            <input
              aria-invalid={expectedInvalid || undefined}
              autoComplete="off"
              className="input mono"
              id="checksum-compare-input"
              onChange={(event) => setExpectedText(event.currentTarget.value)}
              placeholder="Paste a CRC32, MD5, SHA-1, or other checksum"
              spellCheck={false}
              type="text"
              value={expectedText}
            />
          </label>
          {expectedInvalid ? (
            <Notice level="error">A checksum contains only the digits 0-9 and the letters a-f.</Notice>
          ) : null}
          {compare?.match && matchedSets.length ? (
            <p className="pdesc checksum-verdict" id="checksum-compare-verdict">
              {matchedSets.length === 1
                ? `Match: the ${matchedLabel} of this file${matchedText ? ` (${matchedText})` : ""}.`
                : `Match: the ${matchedLabel} of ${matchedText}.`}
            </p>
          ) : null}
          {compare && !compare.match && files.length ? (
            <Notice id="checksum-compare-verdict" level={compare.uncomputed.length ? "warn" : "error"}>
              {compare.uncomputed.length
                ? `No computed checksum matches. Calculate ${compare.uncomputed.join(" or ")} to compare this value.`
                : expected.length && !CHECKSUM_ALGORITHMS.some((entry) => entry.hexLength === expected.length)
                  ? `No supported algorithm makes a ${expected.length}-character checksum.`
                  : "No computed checksum matches. This is not the expected file, or it needs a different header or byte order."}
            </Notice>
          ) : null}
        </StepSection>
      )}
      {errors.map((entry) => (
        <Notice key={entry.id} level="error" onDismiss={entry.dismissError}>
          {entry.error}
        </Notice>
      ))}
      {candidateSelectionDialog}
    </section>
  );
};

export { ChecksumForm, type ChecksumFormProps };
