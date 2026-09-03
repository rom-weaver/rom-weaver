import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import { createLogger } from "../../lib/logging.ts";
import {
  IDENTIFY_STATUS_LABEL,
  IDENTIFY_STATUS_MARK,
  identifyMatchCountLabel,
} from "../../presentation/identify-status.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { RomInputPanels } from "../../public/react/components/ds/rom-input-panels.tsx";
import {
  compareRomExpectation,
  ROM_HASH_LOOKUP_MESSAGES,
  RomExpectationCard,
  RomHashSearch,
  type RomExpectation,
} from "../../public/react/components/ds/rom-expectation-card.tsx";
import { WorkflowRomInputStep } from "../../public/react/components/ds/workflow-rom-input-step.tsx";
import { ARCHIVE_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "../../public/react/file-classification.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { useRomHashLookup } from "../../public/react/use-rom-hash-lookup.ts";
import { identifyRecordChecks } from "../../lib/identify/identify-record-checks.ts";
import type { ParsedIdentifyCandidate, ParsedIdentifyResult } from "../../types/identify.ts";

const IDENTIFY_ACTIVITY_KEY = "identify";

const logger = createLogger("identify-form");

/* Derived from the real ingest filters, so a format rom-weaver can actually
   read is never missing from the ticker and never blocked by an accept rule. */
const IDENTIFY_SUPPORTED_FILES = [
  { extensions: ROM_FILE_EXTENSIONS, label: "ROMs" },
  { extensions: ARCHIVE_FILE_EXTENSIONS, label: "Archives & containers" },
] as const;

type IdentifyFormProps = {
  containerId?: string;
  inputId?: string;
  pageDrop?: PageFileDrop | null;
};

const CandidateStatusChip = ({ status }: { status: ParsedIdentifyCandidate["status"] }) => {
  const mark = IDENTIFY_STATUS_MARK[status];
  return (
    <span className="rb mono identify-state">
      <span aria-hidden="true" className="identify-state-glyph">
        {mark.glyph}
      </span>
      <span>{mark.label}</span>
    </span>
  );
};

/**
 * One candidate's verdict rendered inside the staged ROM card, apply-style:
 * the Identify and Checks drawers attach to the card instead of separate
 * result cards, both open on arrival.
 */
const CandidateResult = ({
  candidate,
  expected,
  showMemberPath,
}: {
  candidate: ParsedIdentifyCandidate;
  /** A pasted-checksum expectation, so the staged card carries its match marks. */
  expected?: { checksums?: Record<string, string>; size?: number };
  showMemberPath: boolean;
}) => {
  const identification = {
    matches: candidate.matches,
    status: candidate.status,
    ...(candidate.condition ? { condition: candidate.condition } : {}),
    ...(candidate.hint ? { hint: candidate.hint } : {}),
    ...(candidate.quality ? { quality: candidate.quality } : {}),
    ...(candidate.platformCandidates ? { platformCandidates: candidate.platformCandidates } : {}),
    ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
    ...(candidate.database ? { database: candidate.database } : {}),
  };
  // A matched record completes the drawer: a pasted checksum computes one
  // digest and the record knows the other two plus the exact size.
  const database = identifyRecordChecks(identification);
  return (
    <>
      {showMemberPath ? <p className="pdesc mono identify-member">ROM: {candidate.path}</p> : null}
      {candidate.status === "ambiguous" ? (
        <p className="pdesc identify-ambiguous-lead">
          {identifyMatchCountLabel(candidate.matches.length)} share this ROM&rsquo;s checksums. Every candidate is
          listed in the Identify drawer below.
        </p>
      ) : null}
      {candidate.status === "unknown" && showMemberPath ? (
        <p className="pdesc identify-unknown-lead">No matching checksum for this ROM in the identification data.</p>
      ) : null}
      <RomInputPanels
        identification={identification}
        identifyDefaultOpen
        info={{
          ...(typeof candidate.sizeBytes === "number" ? { bytes: candidate.sizeBytes } : {}),
          checksums: candidate.checksums,
          checksumVariants: candidate.checksumVariants,
          ...(database ? { database } : {}),
          defaultOpen: true,
          ...(expected ? { expected } : {}),
        }}
      />
    </>
  );
};

const IdentifyForm = ({
  containerId = "identify-container",
  inputId = "identify-input-picker",
  pageDrop,
}: IdentifyFormProps) => {
  const localizer = useUiLocalizer();
  const [file, setFile] = useState<File | null>(null);
  const romHashLookup = useRomHashLookup(ROM_HASH_LOOKUP_MESSAGES(localizer));
  const [result, setResult] = useState<ParsedIdentifyResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const handledDropRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /* Every state write is gated on this token. A run that was replaced, removed,
     or unmounted MUST NOT repopulate the form when it finally resolves. */
  const runTokenRef = useRef(0);

  const cancelRun = useCallback(() => {
    runTokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setStage("");
    setPercent(null);
  }, []);

  /** Run one identify operation, gated on the run token like every state write. */
  const runOperation = useCallback(
    async (
      operation: (context: {
        onProgress: (message: string, percent: number | null) => void;
        signal: AbortSignal;
      }) => Promise<ParsedIdentifyResult>,
    ) => {
      runTokenRef.current += 1;
      const token = runTokenRef.current;
      const abort = new AbortController();
      abortRef.current = abort;
      setBusy(true);
      setStage("");
      setPercent(null);
      setError("");
      setResult(null);
      try {
        const identified = await operation({
          onProgress: (message, progressPercent) => {
            if (runTokenRef.current !== token) return;
            if (message) setStage(message);
            setPercent(progressPercent);
          },
          signal: abort.signal,
        });
        if (runTokenRef.current !== token) return;
        setResult(identified);
      } catch (cause) {
        if (runTokenRef.current !== token || abort.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (runTokenRef.current === token) {
          abortRef.current = null;
          setBusy(false);
          setStage("");
          setPercent(null);
        }
      }
    },
    [],
  );

  const runFile = useCallback(
    async (next: File) => {
      await runOperation(async ({ onProgress, signal }) => {
        const { identifyRom } = await import("../../platform/browser/browser-api.ts");
        return identifyRom(next, next.name, {
          onProgress: (progress) => onProgress(progress.message || progress.label || "", progress.percent ?? null),
          signal,
        });
      });
    },
    [runOperation],
  );

  /* Adding a ROM identifies it right away - no separate run click. A checksum
     expectation found before the drop is kept: the staged ROM is then checked
     against it. */
  const selectFile = useCallback(
    (next: File) => {
      cancelRun();
      setFile(next);
      setResult(null);
      setError("");
      void runFile(next);
    },
    [cancelRun, runFile],
  );

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    const selected = pageDrop.files.at(-1);
    if (selected) selectFile(selected);
  }, [pageDrop, selectFile]);

  useEffect(() => {
    if (busy) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { stage: stage || "Identify ROM", state: "running" });
    else if (error) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "failed" });
    else if (result)
      setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, {
        stage: IDENTIFY_STATUS_LABEL[result.status],
        state: result.status === "unavailable" ? "failed" : "done",
      });
    else if (file) setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "ready" });
    else setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "idle" });
  }, [busy, error, file, result, stage]);

  useEffect(
    () => () => {
      runTokenRef.current += 1;
      abortRef.current?.abort();
      setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "idle" });
    },
    [],
  );

  /* The unavailable notice only renders for a staged file; the checksum search
     reports its own failures inline. */
  const retry = () => {
    if (busy || !file) return;
    void runFile(file);
  };

  const removeFile = () => {
    cancelRun();
    setFile(null);
    setResult(null);
    setError("");
  };

  const unavailable = result?.status === "unavailable";
  const archiveName = result?.archiveName;
  const candidates = result?.candidates || [];
  const showMemberPaths = !!archiveName;

  /* A pasted checksum that the local data recognized is an expectation: it says
     which ROM this run is about before any file exists, and the staged ROM is
     then compared against it. */
  const expectation: RomExpectation | undefined = romHashLookup.result
    ? { checks: romHashLookup.result.checks, source: "manual" }
    : undefined;
  const expectationChecks = expectation?.checks;
  const hadExpectationRef = useRef(false);
  useEffect(() => {
    if (expectationChecks) {
      hadExpectationRef.current = true;
      logger.debug("expected ROM set from a checksum lookup", { checks: expectationChecks });
      return;
    }
    if (!hadExpectationRef.current) return;
    hadExpectationRef.current = false;
    logger.debug("expected ROM cleared");
  }, [expectationChecks]);
  /* The hero stands until something answers 0x02 - a file, or a checksum the
     data recognized. Typing, a search in flight, or a failed one all leave it
     in place: nothing flips for a non-answer. */
  const heroShown = !(file || expectation);

  /* One pasted checksum describes one ROM, so an archive that yields several
     candidates is never compared: nobody knows which member it was meant for. */
  const comparableChecks = file && result && !unavailable && candidates.length === 1 ? expectationChecks : undefined;
  const expectationVerdict =
    comparableChecks && file
      ? compareRomExpectation(expectation, { checksums: candidates[0]?.checksums, size: file.size })
      : undefined;
  const identifyTone = result && !unavailable ? IDENTIFY_STATUS_MARK[result.status].tone : undefined;
  const cardState = expectationVerdict ?? identifyTone;
  const romStepFault = !!error || (expectationVerdict ? expectationVerdict === "bad" : result?.status === "unknown");
  const romStepWoven = expectationVerdict
    ? expectationVerdict === "ok"
    : !!result && !unavailable && result.status !== "unknown";

  /* A database that never loaded is not a ROM verdict: say so, keep the
     technical cause in the log, and offer the retry. */
  const unavailableBlock = unavailable ? (
    <div className="cards">
      <Notice level="warn">
        Identification data could not be loaded. Your ROM was not classified. Check your connection and try again.
      </Notice>
      {/* Retry replays the file or the still-entered hash; with neither there is
          nothing to replay, so the button MUST NOT look actionable. */}
      <RunButton
        disabled={busy || !(file || romHashLookup.text.trim())}
        icon={<RotateCcw aria-hidden="true" />}
        onClick={retry}
      >
        Retry identification
      </RunButton>
    </div>
  ) : null;

  const errorBlock = error ? (
    <Notice level="error" onDismiss={() => setError("")}>
      {error}
    </Notice>
  ) : null;

  return (
    <section className="panel" id={containerId}>
      <UnifiedDropZone
        addLabel={file ? "Replace the ROM" : expectation ? "Add the ROM to verify it" : "Add a ROM to identify it"}
        /* The search is the hero's quiet second door, after the drop target;
           once a match fills 0x02 it moves there as the refine row. */
        afterDropZone={
          heroShown ? <RomHashSearch idPrefix={containerId} localizer={localizer} lookup={romHashLookup} /> : null
        }
        big={heroShown}
        disabled={busy}
        {...(!file && expectation ? { hint: "Optional - the match above stands on its own" } : {})}
        heroLabel="Drop a ROM to identify it"
        heroLabelCoarse="Tap to add a ROM"
        info={<p>Identification runs locally. Your ROM never leaves this browser.</p>}
        inputId={inputId}
        lead={{ line1: "ui.hero.identifyThesis", line2: "ui.hero.identifyThesis2" }}
        multiple={false}
        onFiles={(files) => {
          const selected = files.at(-1);
          if (selected) selectFile(selected);
        }}
        supported={IDENTIFY_SUPPORTED_FILES}
      />
      {file ? (
        <WorkflowRomInputStep
          beforeItems={
            result && !unavailable && result.status === "unknown" ? (
              <Notice level="error">
                No matching checksum found in the identification data. The ROM may be modified, an unlisted revision, or
                from a system that is not in the local data. Its checksums are on the card below so you can look them up
                elsewhere.
              </Notice>
            ) : null
          }
          afterItems={
            <>
              {errorBlock}
              {unavailableBlock}
              {result && !unavailable && !candidates.length ? (
                <Notice level="warn">No ROM was found in this input, so nothing could be identified.</Notice>
              ) : null}
            </>
          }
          fault={romStepFault}
          items={[
            busy
              ? {
                  id: "identify-rom",
                  progress: {
                    cancelLabel: "Cancel identification",
                    indeterminate: percent == null,
                    label: stage || `Identifying ${file.name}…`,
                    onCancel: cancelRun,
                    percent: percent ?? undefined,
                    value: percent == null ? undefined : `${Math.round(percent)}%`,
                  },
                }
              : {
                  card: {
                    children:
                      result && !unavailable ? (
                        <>
                          {candidates.map((candidate) => (
                            <CandidateResult
                              candidate={candidate}
                              {...(comparableChecks ? { expected: comparableChecks } : {})}
                              key={candidate.path}
                              showMemberPath={showMemberPaths}
                            />
                          ))}
                        </>
                      ) : undefined,
                    displayName: file.name,
                    extract: { fileName: file.name, fileSize: file.size },
                    meta: (
                      <>
                        <span className="fsize mono">{formatByteSize(file.size)}</span>
                        {result && !unavailable && candidates.length ? (
                          <CandidateStatusChip status={result.status} />
                        ) : null}
                      </>
                    ),
                    onRemove: removeFile,
                    removeLabel: "Remove ROM",
                    state: cardState,
                  },
                  id: "identify-rom",
                },
          ]}
          num="0x02"
          title={localizer.message("ui.step.rom")}
          woven={romStepWoven}
        />
      ) : expectation ? (
        /* A checksum match is an answer on its own, so the ROM step opens to
           hold it; the ROM that verifies it is added in 0x01 like any other
           input. The search stays under the card as the refine row until then. */
        <WorkflowRomInputStep
          afterItems={errorBlock}
          emptyState={
            <>
              <RomExpectationCard
                expectation={expectation}
                id={`${containerId}-expected-rom`}
                identification={romHashLookup.result?.identification}
                onRemove={romHashLookup.clear}
                removeLabel="Clear the expected ROM"
              />
              <RomHashSearch idPrefix={containerId} localizer={localizer} lookup={romHashLookup} variant="compact" />
            </>
          }
          items={[]}
          num="0x02"
          title={localizer.message("ui.step.rom")}
          woven
        />
      ) : (
        <GhostSteps steps={[{ num: "0x02", title: localizer.message("ui.step.rom") }]} />
      )}
    </section>
  );
};

export { IdentifyForm };
export type { IdentifyFormProps };
