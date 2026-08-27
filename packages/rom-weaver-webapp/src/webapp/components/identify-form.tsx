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
import { formatIdentifyTitle } from "../../presentation/identify-title.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { ChecksumList, ChecksumRow } from "../../public/react/components/ds/checksum-list.tsx";
import { Notice, RunButton } from "../../public/react/components/ds/feedback.tsx";
import { FileCard } from "../../public/react/components/ds/file-card.tsx";
import { NeedsInput, StepSection } from "../../public/react/components/ds/layout.tsx";
import { UnifiedDropZone } from "../../public/react/components/ds/unified-drop-zone.tsx";
import { ARCHIVE_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "../../public/react/file-classification.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
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

/** Match-quality chip; renders only for the set-aware (RWFP2) results that carry one. */
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
  const names = [...new Set(candidate.matches.map((match) => formatIdentifyTitle(match.name)).filter(Boolean))];
  const heading = names[0] || candidate.path;
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
              <span className="identify-result-title">{formatIdentifyTitle(match.name)}</span>
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
          No exact title match found. The ROM may be modified, an unlisted revision, or from a system that is not in the
          local identification data. Its checksums are below so you can look it up elsewhere.
        </p>
      ) : null}
      <IdentifyDrawer
        identification={{
          matches: candidate.matches,
          status: candidate.status,
          ...(candidate.quality ? { quality: candidate.quality } : {}),
          ...(candidate.platformCandidates ? { platformCandidates: candidate.platformCandidates } : {}),
          ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
          ...(candidate.database ? { database: candidate.database } : {}),
        }}
        memberPath={showMemberPath ? candidate.path : undefined}
      />
      {/* An unidentified ROM opens on its checksums: they are the only thing that
          still helps the reader, so they must not need a second click. */}
      <ChecksumList defaultOpen={candidate.status === "unknown"} label="Checksums">
        {Object.entries(candidate.checksums).map(([algorithm, checksum]) => (
          <ChecksumRow key={algorithm} label={algorithm.toUpperCase()} value={checksum} />
        ))}
      </ChecksumList>
    </FileCard>
  );
};

const IdentifyForm = ({
  containerId = "identify-container",
  inputId = "identify-input-picker",
  pageDrop,
}: IdentifyFormProps) => {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ParsedIdentifyResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
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
  }, []);

  const selectFile = useCallback(
    (next: File) => {
      cancelRun();
      setFile(next);
      setResult(null);
      setError("");
    },
    [cancelRun],
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

  const run = async () => {
    if (!(file && !busy)) return;
    runTokenRef.current += 1;
    const token = runTokenRef.current;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setStage("");
    setError("");
    setResult(null);
    try {
      const { identifyRom } = await import("../../platform/browser/browser-api.ts");
      const identified = await identifyRom(file, file.name, {
        onProgress: (progress) => {
          if (runTokenRef.current !== token) return;
          const message = progress.message || progress.label || "";
          if (message) setStage(message);
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
      }
    }
  };

  const unavailable = result?.status === "unavailable";
  const archiveName = result?.archiveName;
  const candidates = result?.candidates || [];
  const showMemberPaths = !!archiveName;

  return (
    <section className="panel" id={containerId}>
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
      <StepSection num="0x02" title="ROM">
        {file ? (
          <div className="cards">
            <FileCard
              meta={<span className="fsize mono">{formatByteSize(file.size)}</span>}
              name={<span className="nm mono">{file.name}</span>}
              onRemove={() => {
                cancelRun();
                setFile(null);
                setResult(null);
                setError("");
              }}
              removeLabel={busy ? "Cancel and remove ROM" : "Remove ROM"}
            />
          </div>
        ) : (
          <NeedsInput onClick={() => document.getElementById(inputId)?.click()}>
            Add a ROM in the <b className="hexref mono">0x01</b> drop zone.
          </NeedsInput>
        )}
      </StepSection>
      <StepSection fault={!!error} num="0x03" title="Identify" woven={!!result && !unavailable}>
        {error ? (
          <Notice level="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        ) : null}
        <RunButton disabled={!file || busy} icon={<Search aria-hidden="true" />} onClick={() => void run()}>
          {busy ? stage || "Identifying ROM…" : "Identify ROM"}
        </RunButton>
        {/* A database that never loaded is not a ROM verdict: say so, keep the
            technical cause in the log, and offer the retry. */}
        {unavailable ? (
          <div className="cards">
            <Notice level="warn">
              Identification data could not be loaded. Your ROM was not classified. Check your connection and try again.
            </Notice>
            <RunButton disabled={busy} icon={<RotateCcw aria-hidden="true" />} onClick={() => void run()}>
              Retry identification
            </RunButton>
          </div>
        ) : null}
        {result && !unavailable ? (
          <div className="cards">
            {archiveName ? (
              <p className="pdesc identify-archive-lead">
                <span className="mono">Archive: {archiveName}</span>
                {candidates.length > 1 ? (
                  <>
                    {" "}
                    <span>
                      {candidates.length} ROMs found in this archive. Each one is identified on its own below.
                    </span>
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
        ) : null}
      </StepSection>
    </section>
  );
};

export { IdentifyForm };
export type { IdentifyFormProps };
