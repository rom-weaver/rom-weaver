import { Hash } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
import { InfoPopover, StepSection } from "../../public/react/components/ds/layout.tsx";
import {
  StageStatus,
  stageBarValue,
  stagePercent,
  stageStatusLabel,
} from "../../public/react/components/ds/staging-meta.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { WorkflowRomInputStep } from "../../public/react/components/ds/workflow-rom-input-step.tsx";
import { useInputSelectionHandler } from "../../public/react/input-selection-handler.ts";
import type { CandidateSelectionPrompt, PageFileDrop } from "../../public/react/public-types.ts";
import { useApplySettings, useRomWeaverAssetBaseUrl, useUiLocalizer } from "../../public/react/settings-context.tsx";
import { usePageDropForwarder, useWorkbenchActivity } from "../../public/react/workflow-form-effects.ts";
import {
  createReactWorkflowId,
  formatOptionalElapsedMs,
  getSourceNoticeLevel,
  getSourceNoticeMessage,
  hasSourceQueueWarning,
} from "../../public/react/workflow-form-utils.ts";
import { loadBrowserApi } from "../../public/react/workflow-loader.ts";
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
type CompareResult = { match?: { algorithm: string; setId: string }; uncomputed: string[] } | null;

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
  for (const set of sets) {
    const algorithm = candidates.find((entry) => algorithms.includes(entry.id) && set.checksums[entry.id] === expected);
    if (algorithm) return { match: { algorithm: algorithm.id, setId: set.id }, uncomputed: [] };
  }
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
      const matched = compare?.match?.setId === set.id && compare.match.algorithm === algorithm.id;
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

const ChecksumForm = ({ pageDrop }: ChecksumFormProps) => {
  const localizer = useUiLocalizer();
  const settings = useApplySettings();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const cancelSelectionRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    fileInput: true,
    onCancelSelection: (request) => cancelSelectionRef.current(request),
  });
  // Matches webapp-root's `currentView` so root routing targets this tab's dialog.
  useInputSelectionHandler("checksum", selectFile);
  const [source, setSource] = useState<File | null>(null);
  const [input, setInput] = useState<ChecksumWorkflowSourceState | null>(null);
  const [staging, setStaging] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [algorithms, setAlgorithms] = useState<string[]>(DEFAULT_ALGORITHMS);
  const [expectedText, setExpectedText] = useState("");
  const [error, setError] = useState("");
  const [autoExtract, setAutoExtract] = useState(true);
  const algorithmsRef = useRef(algorithms);
  algorithmsRef.current = algorithms;
  const { clearProgressForStage, createProgressHandler, progress, setProgress } = useWorkflowProgressState({});
  const workflowRef = useRef<InstanceType<typeof BrowserChecksumWorkflow> | null>(null);
  const workflowIdRef = useRef(createReactWorkflowId("react-checksum"));
  const handledPageDropIdRef = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // A language or byte-unit change makes a new localizer; reading it through a
  // ref keeps showError stable so the staging effect does not restage the ROM.
  const localizerRef = useRef(localizer);
  localizerRef.current = localizer;
  const showError = useCallback(
    (cause: unknown) => setError(formatCodedErrorForDisplay(cause, localizerRef.current)),
    [],
  );

  const updateSource = useCallback((file: File | null) => {
    setError("");
    setSource(file);
  }, []);

  cancelSelectionRef.current = (request) => {
    if (request.sourceIndex === -1) return;
    updateSource(null);
  };

  const handleDrop = (files: File[]) => {
    const file = files[0];
    if (file) updateSource(file);
  };
  usePageDropForwarder(pageDrop, handleDrop, handledPageDropIdRef);

  // One workflow per staged ROM: a new source disposes the old workflow, which
  // releases its extracted files.
  useEffect(() => {
    setInput(null);
    // A calculation on the previous ROM ends with its workflow, and its own
    // settle is gated on that workflow still being current.
    setCalculating(false);
    if (!source) {
      setStaging(false);
      return;
    }
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
      logger.debug("staging ROM", { fileName: source.name, size: source.size });
      try {
        await workflow.setInput(source, { algorithms: algorithmsRef.current, autoExtract });
        if (current) setInput(workflow.getInput());
      } catch (cause) {
        if (!current) return;
        setInput(workflow.getInput());
        const code = getErrorCode(cause);
        logger.debug("staging failed", { code, fileName: source.name });
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
  }, [assetBaseUrl, autoExtract, clearProgressForStage, createProgressHandler, selectFile, showError, source]);

  const files = input?.status === "ready" ? input.files : [];
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
  const matchedSet = sets.find((set) => set.id === compare?.match?.setId);
  const matchedLabel = CHECKSUM_ALGORITHMS.find((entry) => entry.id === compare?.match?.algorithm)?.label;
  const stagingChecksum = staging && progress?.stage === "checksum";
  const stagingProgress = stagingChecksum
    ? toWorkflowChecksumProgressProps(progress)
    : toWorkflowFileProgressProps(staging ? progress : null);
  const stagePct = stagePercent(stagingProgress);
  const primary = files[0];
  const sourceNotice = getSourceNoticeMessage(input);
  const sourceEmpty = !source;

  return (
    <section className="panel checksum-tool" id="checksum-container">
      {sourceEmpty ? (
        <UnifiedDropZone
          addLabel="Replace the file"
          big={sourceEmpty}
          disabled={calculating}
          heroLabel="Drop a file to checksum it"
          heroLabelCoarse="Tap to add a file"
          info={<p>Checksums are calculated locally. Your file never leaves this browser.</p>}
          inputId="checksum-input-picker"
          lead={{
            line1: "ui.hero.checksumThesis",
            line2: "ui.hero.checksumThesis2",
            description: "ui.hero.checksumDescription",
          }}
          multiple={false}
          onFiles={handleDrop}
          title="Input"
        />
      ) : (
        <WorkflowRomInputStep
          dropZone={{
            disabled: calculating,
            inputId: "checksum-input-picker",
            label: "Replace the file",
            multiple: false,
            onFiles: handleDrop,
          }}
          fault={hasSourceQueueWarning(input) || (!!error && !files.length)}
          id="checksum-source"
          info={
            <InfoPopover title="File input">
              <ul>
                <li>When Auto extract is on, choose a file if the archive contains several.</li>
                <li>Turn Auto extract off to checksum an archive without opening it.</li>
              </ul>
            </InfoPopover>
          }
          items={[
            {
              card: {
                extract: {
                  fileName: input?.fileName || source.name,
                  fileSize: input?.size,
                  parentCompressions: input?.parentCompressions,
                  timing: formatOptionalElapsedMs(input?.decompressionTimeMs),
                },
                meta: staging ? (
                  <>
                    <span className="fsize mono">{formatByteSize(input?.size ?? source.size)}</span>
                    <StageStatus
                      id="checksum-input-stage"
                      label={stageStatusLabel("Checksumming", !stagingChecksum, localizer)}
                      percent={stagePct}
                    />
                  </>
                ) : (
                  <span className="fsize mono">{formatByteSize(input?.size ?? source.size)}</span>
                ),
                onRemove: () => updateSource(null),
                panels: {
                  ...(input?.identification ? { identification: input.identification } : {}),
                  identifyPending: false,
                  info: {
                    bytes: primary?.size,
                    checksums: primary?.checksums,
                    checksumVariants: primary?.checksumVariants,
                    defaultOpen: false,
                  },
                },
                removeLabel: "Remove file",
                stageBar: stageBarValue(staging, stagePct),
                state: hasSourceQueueWarning(input) ? "bad" : input?.status === "ready" ? "ok" : undefined,
              },
              id: "checksum-input-card",
            },
          ]}
          notice={
            sourceNotice ? (
              <Notice id="checksum-source-notice" level={getSourceNoticeLevel(input)}>
                {sourceNotice}
              </Notice>
            ) : null
          }
          num="0x01"
          title="Input"
          woven={files.length > 0}
        />
      )}
      <StepSection id="checksum-options" num="0x02" title={localizer.message("ui.output.options")}>
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
        <div className="checksum-extract">
          <label className="checkrow">
            <input
              aria-describedby="checksum-extract-description"
              checked={autoExtract}
              disabled={calculating || staging}
              id="checksum-auto-extract"
              onChange={(event) => setAutoExtract(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>Auto extract</span>
          </label>
          <p className="pdesc" id="checksum-extract-description">
            Open archives and containers before calculating checksums. Turn off to checksum the original file.
          </p>
        </div>
      </StepSection>
      {sourceEmpty ? null : (
        <StepSection
          className="checksum-results"
          fault={!!compare && !compare.match && !compare.uncomputed.length}
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
          {source && !staging && missing.length ? (
            calculating ? (
              <FileProgress
                {...(toWorkflowChecksumProgressProps(progress) || { indeterminate: true, label: "Checksum" })}
                cancelLabel="Cancel checksum"
                id="checksum-calculate-progress"
                onCancel={() => workflowRef.current?.abort()}
              />
            ) : (
              <RunButton icon={<Hash aria-hidden="true" />} id="checksum-calculate" onClick={() => void calculate()}>
                {`Calculate ${missing
                  .map((algorithm) => CHECKSUM_ALGORITHMS.find((entry) => entry.id === algorithm)?.label)
                  .join(", ")}`}
              </RunButton>
            )
          ) : null}
          {primary ? (
            <ChecksumList defaultOpen label={localizer.message("ui.checks.title")}>
              {sets.map((set, index) => (
                <Fragment key={set.id}>
                  {set.label || index > 0 ? (
                    <div className="ck-group">
                      <div className="ck-group-head">{set.label}</div>
                      <ChecksumSetRows
                        algorithms={algorithms}
                        compare={compare}
                        expected={expected}
                        pending={calculating}
                        set={set}
                      />
                    </div>
                  ) : (
                    <>
                      <ChecksumSetRows
                        algorithms={algorithms}
                        bytes={primary.size}
                        compare={compare}
                        expected={expected}
                        pending={calculating}
                        set={set}
                      />
                    </>
                  )}
                </Fragment>
              ))}
            </ChecksumList>
          ) : null}
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
          {compare?.match && matchedSet ? (
            <p className="pdesc checksum-verdict" id="checksum-compare-verdict">
              Match: the {matchedLabel} of this file{matchedSet.label ? ` (${matchedSet.label})` : ""}.
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
      {error ? (
        <Notice level="error" onDismiss={() => setError("")}>
          {error}
        </Notice>
      ) : null}
      {candidateSelectionDialog}
    </section>
  );
};

export { ChecksumForm, type ChecksumFormProps };
