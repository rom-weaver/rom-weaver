import { RotateCcw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import {
  IDENTIFY_CONDITION_LABEL,
  IDENTIFY_QUALITY_MARK,
  IDENTIFY_STATUS_LABEL,
  IDENTIFY_STATUS_MARK,
  identifyMatchCountLabel,
} from "../../presentation/identify-status.ts";
import { uniqueIdentifyDisplayNames } from "../../presentation/identify-title.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { GhostSteps } from "../../public/react/components/ds/ghost-steps.tsx";
import { StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { RomInputPanels } from "../../public/react/components/ds/rom-input-panels.tsx";
import { WorkflowRomInputStep } from "../../public/react/components/ds/workflow-rom-input-step.tsx";
import { ARCHIVE_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "../../public/react/file-classification.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { identifyHashAlgorithm } from "../../types/identify.ts";
import type { ParsedIdentifyCandidate, ParsedIdentifyResult } from "../../types/identify.ts";
import { IdentifyDrawer } from "./identify-drawer.tsx";

const IDENTIFY_ACTIVITY_KEY = "identify";

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

/** Stable identity for a match row: two records can share platform and name. */
const matchKey = (candidatePath: string, match: ParsedIdentifyResult["candidates"][number]["matches"][number]) =>
  [candidatePath, match.database, match.platform, match.name, match.algorithm, match.variant].join("|");

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

/** Match-quality chip; renders only for set-aware results that carry one. */
const CandidateQualityChip = ({ quality }: { quality: NonNullable<ParsedIdentifyCandidate["quality"]> }) => {
  const mark = IDENTIFY_QUALITY_MARK[quality];
  return (
    <span className="rb mono identify-state identify-quality">
      <span aria-hidden="true" className="identify-state-glyph">
        {mark.glyph}
      </span>
      <span>{mark.label}</span>
    </span>
  );
};

/**
 * A structured non-match condition is an actionable state, not a plain "no
 * match": name the cause and show the hint.
 */
const CandidateConditionNotice = ({
  condition,
  hint,
}: {
  condition: NonNullable<ParsedIdentifyCandidate["condition"]>;
  hint?: string;
}) => (
  <Notice level="warn">
    <b>{IDENTIFY_CONDITION_LABEL[condition]}.</b>{" "}
    {hint ||
      (condition === "database_required"
        ? "The identification database for this platform is not downloaded."
        : "This media layout has no supported identification profile yet.")}
  </Notice>
);

const CandidateCard = ({
  candidate,
  showMemberPath,
}: {
  candidate: ParsedIdentifyCandidate;
  showMemberPath: boolean;
}) => {
  const names = uniqueIdentifyDisplayNames(candidate.matches);
  const heading = names.join(" · ") || candidate.path;
  const mark = IDENTIFY_STATUS_MARK[candidate.status];
  return (
    <FileCard
      description={
        showMemberPath ? <span className="pdesc mono identify-member">ROM: {candidate.path}</span> : undefined
      }
      meta={
        <>
          {candidate.quality ? <CandidateQualityChip quality={candidate.quality} /> : null}
          <CandidateStatusChip status={candidate.status} />
        </>
      }
      name={<span className="identify-result-title">{heading}</span>}
      state={mark.tone}
    >
      {candidate.status === "ambiguous" ? (
        <p className="pdesc identify-ambiguous-lead">
          {identifyMatchCountLabel(candidate.matches.length)} share this ROM&rsquo;s checksums. Every candidate is
          listed below.
        </p>
      ) : null}
      {candidate.status === "ambiguous" ? (
        <ul className="identify-candidate-list">
          {candidate.matches.map((match) => (
            <li key={matchKey(candidate.path, match)}>
              <span className="identify-result-title">{uniqueIdentifyDisplayNames([match]).join(" · ")}</span>
              <span className="rb mono muted">
                {[match.platform, match.algorithm.toUpperCase(), match.variant].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {candidate.condition ? <CandidateConditionNotice condition={candidate.condition} hint={candidate.hint} /> : null}
      {candidate.status === "unknown" && !candidate.condition ? (
        <p className="pdesc identify-unknown-lead">
          No matching checksum found in the identification data. The ROM may be modified, an unlisted revision, or from
          a system that is not in the local data.
        </p>
      ) : null}
      <IdentifyDrawer
        defaultOpen
        identification={{
          matches: candidate.matches,
          status: candidate.status,
          ...(candidate.condition ? { condition: candidate.condition } : {}),
          ...(candidate.hint ? { hint: candidate.hint } : {}),
          ...(candidate.quality ? { quality: candidate.quality } : {}),
          ...(candidate.platformCandidates ? { platformCandidates: candidate.platformCandidates } : {}),
          ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
          ...(candidate.database ? { database: candidate.database } : {}),
        }}
        memberPath={showMemberPath ? candidate.path : undefined}
      />
      {/* The evidence is the page's product, so both drawers open on arrival. */}
      <ChecksumList defaultOpen label="Checksums">
        {Object.entries(candidate.checksums).map(([algorithm, checksum]) => (
          <ChecksumRow key={algorithm} label={algorithm.toUpperCase()} value={checksum} />
        ))}
      </ChecksumList>
    </FileCard>
  );
};

/**
 * One candidate's verdict rendered inside the staged ROM card, apply-style:
 * the Identify and Checks drawers attach to the card instead of separate
 * result cards, both open on arrival.
 */
const CandidateResult = ({
  candidate,
  showMemberPath,
}: {
  candidate: ParsedIdentifyCandidate;
  showMemberPath: boolean;
}) => (
  <>
    {showMemberPath ? <p className="pdesc mono identify-member">ROM: {candidate.path}</p> : null}
    {candidate.status === "ambiguous" ? (
      <p className="pdesc identify-ambiguous-lead">
        {identifyMatchCountLabel(candidate.matches.length)} share this ROM&rsquo;s checksums. Every candidate is listed
        in the Identify drawer below.
      </p>
    ) : null}
    {candidate.status === "unknown" && showMemberPath ? (
      <p className="pdesc identify-unknown-lead">No matching checksum for this ROM in the identification data.</p>
    ) : null}
    <RomInputPanels
      identification={{
        matches: candidate.matches,
        status: candidate.status,
        ...(candidate.condition ? { condition: candidate.condition } : {}),
        ...(candidate.hint ? { hint: candidate.hint } : {}),
        ...(candidate.quality ? { quality: candidate.quality } : {}),
        ...(candidate.platformCandidates ? { platformCandidates: candidate.platformCandidates } : {}),
        ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
        ...(candidate.database ? { database: candidate.database } : {}),
      }}
      identifyDefaultOpen
      info={{
        checksums: candidate.checksums,
        checksumVariants: candidate.checksumVariants,
        defaultOpen: true,
      }}
    />
  </>
);

const IdentifyForm = ({
  containerId = "identify-container",
  inputId = "identify-input-picker",
  pageDrop,
}: IdentifyFormProps) => {
  const localizer = useUiLocalizer();
  const [file, setFile] = useState<File | null>(null);
  const [hashText, setHashText] = useState("");
  const [hashError, setHashError] = useState("");
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

  /* Adding a ROM identifies it right away - no separate run click. The staged
     file also overrides any checksum typed before the drop. */
  const selectFile = useCallback(
    (next: File) => {
      cancelRun();
      setFile(next);
      setHashText("");
      setHashError("");
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

  const runHash = async (value: string) => {
    if (busy) return;
    const normalized = value.trim().toLowerCase();
    if (!identifyHashAlgorithm(normalized)) {
      const invalidChars = /[^0-9a-f]/.test(normalized);
      setHashError(localizer.message(invalidChars ? "ui.identify.hashInvalidChars" : "ui.identify.hashInvalid"));
      return;
    }
    setHashError("");
    cancelRun();
    setFile(null);
    await runOperation(async ({ onProgress, signal }) => {
      const { identifyHash } = await import("../../platform/browser/browser-api.ts");
      return identifyHash(normalized, {
        onProgress: (progress) => onProgress(progress.message || progress.label || "", progress.percent ?? null),
        signal,
      });
    });
  };

  /* Hash search and file identify are alternatives; the retry replays whichever
     one produced the current (unavailable) result. */
  const retry = () => {
    if (busy) return;
    if (file) void runFile(file);
    else if (hashText) void runHash(hashText);
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
  const hashMode = !file && (busy || !!result || !!error);

  const hashInputId = `${containerId}-hash`;
  const hashSearchBlock = (
    <form
      className="identify-hash"
      onSubmit={(event) => {
        event.preventDefault();
        void runHash(hashText);
      }}
    >
      <label className="identify-hash-label" htmlFor={hashInputId}>
        {localizer.message("ui.identify.hashLabel")}
      </label>
      <p className="pdesc identify-hash-hint">{localizer.message("ui.identify.hashHint")}</p>
      <div className="identify-hash-row">
        <input
          aria-invalid={hashError ? "true" : undefined}
          autoComplete="off"
          className="input mono identify-hash-input"
          disabled={busy}
          id={hashInputId}
          onChange={(event) => {
            setHashText(event.currentTarget.value);
            setHashError("");
          }}
          placeholder="crc32 / md5 / sha1"
          spellCheck={false}
          type="text"
          value={hashText}
        />
        <RunButton disabled={busy || !hashText.trim()} icon={<Search aria-hidden="true" />} type="submit">
          {busy && hashMode
            ? stage || localizer.message("ui.identify.hashSearching")
            : localizer.message("ui.identify.hashSearch")}
        </RunButton>
      </div>
      {hashError ? (
        <p className="identify-hash-error" role="alert">
          {hashError}
        </p>
      ) : null}
    </form>
  );

  const resultsBlock =
    result && !unavailable ? (
      <div className="cards">
        {archiveName ? (
          <p className="pdesc identify-archive-lead">
            <span className="mono">Archive: {archiveName}</span>
            {candidates.length > 1 ? (
              <>
                {" "}
                <span>{candidates.length} ROMs found in this archive. Each one is identified on its own below.</span>
              </>
            ) : null}
          </p>
        ) : null}
        {candidates.length ? (
          candidates.map((candidate) => (
            <CandidateCard candidate={candidate} key={candidate.path} showMemberPath={showMemberPaths} />
          ))
        ) : (
          <Notice level="warn">No ROM was found in this input, so nothing could be identified.</Notice>
        )}
      </div>
    ) : null;

  /* A database that never loaded is not a ROM verdict: say so, keep the
     technical cause in the log, and offer the retry. */
  const unavailableBlock = unavailable ? (
    <div className="cards">
      <Notice level="warn">
        Identification data could not be loaded. Your ROM was not classified. Check your connection and try again.
      </Notice>
      {/* Retry replays the file or the still-entered hash; with neither there is
          nothing to replay, so the button MUST NOT look actionable. */}
      <RunButton disabled={busy || !(file || hashText.trim())} icon={<RotateCcw aria-hidden="true" />} onClick={retry}>
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
      {hashSearchBlock}
      <UnifiedDropZone
        addLabel="Replace the ROM"
        big={!file}
        disabled={busy}
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
          fault={!!error || result?.status === "unknown"}
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
                    state: result && !unavailable ? IDENTIFY_STATUS_MARK[result.status].tone : undefined,
                  },
                  id: "identify-rom",
                },
          ]}
          num="0x02"
          title={localizer.message("ui.step.rom")}
          woven={!!result && !unavailable && result.status !== "unknown"}
        />
      ) : hashMode ? (
        <StepSection
          fault={!!error}
          num="0x02"
          title={localizer.message("ui.step.identify")}
          woven={!!result && !unavailable}
        >
          {errorBlock}
          {unavailableBlock}
          {resultsBlock}
        </StepSection>
      ) : (
        <GhostSteps steps={[{ num: "0x02", title: localizer.message("ui.step.rom") }]} />
      )}
    </section>
  );
};

export { IdentifyForm };
export type { IdentifyFormProps };
