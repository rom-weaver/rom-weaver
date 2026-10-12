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
import { WORKFLOW_GUIDES } from "../../public/react/workflow-guides.ts";
import { RomInputPanels } from "../../public/react/components/ds/rom-input-panels.tsx";
import {
  compareRomExpectation,
  ROM_LOOKUP_MESSAGES,
  romLookupSource,
  RomExpectationCard,
  RomSearch,
  type RomExpectation,
} from "../../public/react/components/ds/rom-expectation-card.tsx";
import { RelatedStrip } from "./related-strip.tsx";
import { WorkflowRomInputStep } from "../../public/react/components/ds/workflow-rom-input-step.tsx";
import { ARCHIVE_FILE_EXTENSIONS, ROM_FILE_EXTENSIONS } from "../../public/react/file-classification.ts";
import type { PageFileDrop } from "../../public/react/public-types.ts";
import { resolveAssetUrl } from "../../public/react/asset-url.ts";
import { useRomWeaverAssetBaseUrl, useUiLocalizer } from "../../public/react/settings-context.tsx";
import { useRomLookup, type RomLookupResult, type RomLookupSelection } from "../../public/react/use-rom-lookup.ts";
import { identifyRecordChecks } from "../../lib/identify/identify-record-checks.ts";
import type { ParsedIdentifyCandidate, ParsedIdentifyResult } from "../../types/identify.ts";
import type { CheatRomIdentity } from "../../lib/cheats/index.ts";
import { describeAgentSource, useAgentWorkflow } from "../agent/workflow-registry.ts";
import { IdentifyCheatInspection } from "./identify-cheat-inspection.tsx";

type IdentifyEntry = {
  busy: boolean;
  error: string;
  file: File;
  id: number;
  percent: number | null;
  result: ParsedIdentifyResult | null;
  stage: string;
};

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
  lookupRequest?: { id: number; selection: RomLookupSelection };
  onLookupResultChange?: (result: RomLookupResult | undefined) => void;
  /** The nav's own tab-switch handler, threaded down for the result's related-links strip. */
  onSelectTab?: (id: string) => void;
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

const candidateCheatIdentity = (candidate: ParsedIdentifyCandidate): CheatRomIdentity => {
  const match = candidate.matches[0];
  return {
    key: `identify:${candidate.path}:${candidate.checksums.sha1 || candidate.checksums.md5 || candidate.checksums.crc32 || "unknown"}`,
    checksums: candidate.checksums,
    fileName: candidate.path,
    ...(candidate.detectedPlatform || match?.platform
      ? { platform: candidate.detectedPlatform || match?.platform }
      : {}),
    ...(match?.name ? { title: match.name } : {}),
  };
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
      <IdentifyCheatInspection identity={candidateCheatIdentity(candidate)} label={candidate.path} />
    </>
  );
};

const IdentifyForm = ({
  containerId = "identify-container",
  inputId = "identify-input-picker",
  lookupRequest,
  onLookupResultChange,
  onSelectTab,
  pageDrop,
}: IdentifyFormProps) => {
  const localizer = useUiLocalizer();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  const romLookup = useRomLookup(ROM_LOOKUP_MESSAGES(localizer));
  const applyLookupRef = useRef(romLookup.select);
  applyLookupRef.current = romLookup.select;
  useEffect(() => {
    if (lookupRequest) applyLookupRef.current(lookupRequest.selection);
  }, [lookupRequest]);
  useEffect(() => onLookupResultChange?.(romLookup.result), [onLookupResultChange, romLookup.result]);
  const [entries, setEntries] = useState<IdentifyEntry[]>([]);
  const handledDropRef = useRef(0);
  /* Every state write is gated on the entry's run token. A run that was
     replaced, removed, or unmounted MUST NOT repopulate the form when it
     finally resolves. Files run side by side: the runner's scheduler decides
     how many are admitted at once and queues the rest, as for every workflow. */
  const runsRef = useRef(new Map<number, { abort: AbortController; token: number }>());
  const nextEntryIdRef = useRef(0);
  const runTokenRef = useRef(0);

  const updateEntry = useCallback((id: number, patch: Partial<IdentifyEntry>) => {
    setEntries((previous) => previous.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }, []);

  const cancelEntry = useCallback(
    (id: number) => {
      runsRef.current.get(id)?.abort.abort();
      runsRef.current.delete(id);
      updateEntry(id, { busy: false, percent: null, stage: "" });
    },
    [updateEntry],
  );

  const cancelRun = useCallback(() => {
    for (const id of runsRef.current.keys()) cancelEntry(id);
  }, [cancelEntry]);

  const runEntry = useCallback(
    async (id: number, next: File) => {
      runsRef.current.get(id)?.abort.abort();
      runTokenRef.current += 1;
      const token = runTokenRef.current;
      const abort = new AbortController();
      runsRef.current.set(id, { abort, token });
      const live = () => runsRef.current.get(id)?.token === token;
      updateEntry(id, { busy: true, error: "", percent: null, result: null, stage: "" });
      try {
        const { identifyRom } = await import("../../platform/browser/browser-api.ts");
        const identified = await identifyRom(next, next.name, {
          onProgress: (progress) => {
            if (live())
              updateEntry(id, { percent: progress.percent ?? null, stage: progress.message || progress.label || "" });
          },
          signal: abort.signal,
        });
        if (live()) updateEntry(id, { result: identified });
      } catch (cause) {
        if (live() && !abort.signal.aborted)
          updateEntry(id, { error: cause instanceof Error ? cause.message : String(cause) });
      } finally {
        if (live()) {
          runsRef.current.delete(id);
          updateEntry(id, { busy: false, percent: null, stage: "" });
        }
      }
    },
    [updateEntry],
  );

  /* Adding ROMs identifies them right away - no separate run click - and every
     file gets its own result, like `sha256sum a b c`. A new drop replaces the
     staged set. A checksum expectation found before the drop is kept: a single
     staged ROM is then checked against it. */
  const selectFiles = useCallback(
    (next: File[]) => {
      if (!next.length) return;
      cancelRun();
      const staged = next.map((file) => {
        nextEntryIdRef.current += 1;
        return { busy: true, error: "", file, id: nextEntryIdRef.current, percent: null, result: null, stage: "" };
      });
      setEntries(staged);
      for (const entry of staged) void runEntry(entry.id, entry.file);
    },
    [cancelRun, runEntry],
  );

  useEffect(() => {
    if (!(pageDrop && pageDrop.id !== handledDropRef.current)) return;
    handledDropRef.current = pageDrop.id;
    selectFiles(pageDrop.files);
  }, [pageDrop, selectFiles]);

  const busy = entries.some((entry) => entry.busy);
  const busyEntry = entries.find((entry) => entry.busy);
  const error = entries.find((entry) => entry.error)?.error ?? "";
  const only = entries.length === 1 ? entries[0] : undefined;
  const hasFiles = entries.length > 0;
  const result = only?.result ?? null;
  const unavailable = entries.some((entry) => entry.result?.status === "unavailable");

  useEffect(() => {
    const settled = entries.filter((entry) => entry.result);
    const first = settled[0]?.result;
    setWorkbenchActivity(
      IDENTIFY_ACTIVITY_KEY,
      busyEntry
        ? { stage: busyEntry.stage || "Identify ROM", state: "running" }
        : error
          ? { state: "failed" }
          : first
            ? {
                stage: settled.length === 1 ? IDENTIFY_STATUS_LABEL[first.status] : `${settled.length} ROMs identified`,
                state: unavailable ? "failed" : "done",
              }
            : { state: entries.length ? "ready" : "idle" },
    );
  }, [busyEntry, entries, error, unavailable]);

  useEffect(
    () => () => {
      cancelRun();
      setWorkbenchActivity(IDENTIFY_ACTIVITY_KEY, { state: "idle" });
    },
    [cancelRun],
  );

  /* The unavailable notice only renders for a staged file; the checksum search
     reports its own failures inline. Retry replays every file that did not get
     a verdict. */
  const retry = () => {
    if (busy) return;
    for (const entry of entries)
      if (!entry.result || entry.result.status === "unavailable") void runEntry(entry.id, entry.file);
  };

  const removeEntry = (id: number) => {
    cancelEntry(id);
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
  };

  const candidates = result?.candidates || [];

  /* A pasted checksum that the local data recognized is an expectation: it says
     which ROM this run is about before any file exists, and the staged ROM is
     then compared against it. */
  const expectation: RomExpectation | undefined = romLookup.result
    ? { checks: romLookup.result.checks, source: romLookupSource(romLookup.result.foundBy) }
    : undefined;
  const expectationMatch = romLookup.result?.identification.matches[0];
  const expectationCheatIdentity: CheatRomIdentity | undefined = romLookup.result
    ? {
        key: `identify:checksum:${Object.entries(romLookup.result.checks.checksums || {})
          .map(([algorithm, value]) => `${algorithm}:${value}`)
          .join(",")}`,
        checksums: romLookup.result.checks.checksums,
        ...(expectationMatch?.platform ? { platform: expectationMatch.platform } : {}),
        ...(expectationMatch?.name ? { title: expectationMatch.name } : {}),
      }
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
  const heroShown = !(hasFiles || expectation);

  /* One pasted checksum describes one ROM, so an archive that yields several
     candidates is never compared: nobody knows which member it was meant for. */
  const comparableChecks = only && result && !unavailable && candidates.length === 1 ? expectationChecks : undefined;
  const expectationVerdict =
    comparableChecks && only
      ? compareRomExpectation(expectation, { checksums: candidates[0]?.checksums, size: only.file.size })
      : undefined;
  const romStepFault = !!error || expectationVerdict === "bad";
  const romStepWoven = expectationVerdict
    ? expectationVerdict === "ok"
    : hasFiles &&
      entries.every(
        (entry) => entry.result && entry.result.status !== "unavailable" && entry.result.status !== "unknown",
      );

  const agentResults = entries.map(({ result: r }) =>
    r
      ? {
          status: r.status,
          archiveName: r.archiveName,
          condition: r.condition,
          hint: r.hint,
          unavailableReason: r.unavailableReason,
          candidates: r.candidates.map((candidate) => ({
            path: candidate.path,
            size: candidate.sizeBytes,
            status: candidate.status,
            condition: candidate.condition,
            hint: candidate.hint,
            checksums: candidate.checksums,
            matches: candidate.matches,
          })),
        }
      : null,
  );

  useAgentWorkflow("identify", {
    getState: () => ({
      // `source`, `progress`, and `result` describe the staged file when there is exactly one; with several,
      // read `files`, which carries one entry per file.
      source: only ? describeAgentSource(only.file) : null,
      busy,
      progress: busyEntry
        ? { label: busyEntry.stage || `Identifying ${busyEntry.file.name}…`, percent: busyEntry.percent }
        : null,
      error: error || null,
      result: only ? agentResults[0] : null,
      files: entries.map((entry, index) => ({
        name: entry.file.name,
        error: entry.error || null,
        result: agentResults[index],
      })),
      lookup: romLookup.result ? { checks: romLookup.result.checks, foundBy: romLookup.result.foundBy } : null,
    }),
    actions: {
      retry: {
        description: "Identify the staged files that failed or could not be classified again.",
        enabled: hasFiles && !busy,
        execute: retry,
      },
      cancel: {
        description: "Cancel identification.",
        enabled: busy,
        execute: cancelRun,
      },
    },
  });

  /* An unknown ROM is a result, not a fault: one neutral notice per file. A single file shows it above the
     card; with several files each card carries its own. */
  const noMatchNotice = (verdict: ParsedIdentifyResult | ParsedIdentifyCandidate) => {
    const conditioned =
      "condition" in verdict && verdict.condition
        ? verdict
        : "candidates" in verdict
          ? (verdict.candidates.find((candidate) => candidate.condition) ?? verdict)
          : verdict;
    const condition = conditioned.condition;
    // A structured condition says why the lookup could not answer, so "no match" would be false.
    return condition ? (
      <Notice level="info">
        <b>{localizer.message(`ui.identifyDrawer.condition.${condition}`)}.</b>{" "}
        {conditioned.hint || localizer.message("ui.identifyDrawer.unsupported")}
      </Notice>
    ) : (
      <Notice level="info">
        <b>{localizer.message("ui.identify.noMatchTitle")}</b> {localizer.message("ui.identify.noMatchBody")}{" "}
        <a href={resolveAssetUrl(assetBaseUrl, "docs/identify-roms-browser")} rel="noreferrer" target="_blank">
          {localizer.message("ui.identify.noMatchLink")}
        </a>
      </Notice>
    );
  };

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
        disabled={busy || !(hasFiles || romLookup.text.trim())}
        icon={<RotateCcw aria-hidden="true" />}
        onClick={retry}
      >
        Retry identification
      </RunButton>
    </div>
  ) : null;

  const errorBlock = entries.some((entry) => entry.error) ? (
    <>
      {entries.map((entry) =>
        entry.error ? (
          <Notice key={entry.id} level="error" onDismiss={() => updateEntry(entry.id, { error: "" })}>
            {entries.length > 1 ? `${entry.file.name}: ${entry.error}` : entry.error}
          </Notice>
        ) : null,
      )}
    </>
  ) : null;

  return (
    <section className="panel identify-panel" id={containerId}>
      <UnifiedDropZone
        addLabel={hasFiles ? "Replace the ROMs" : expectation ? "Add the ROM to verify it" : "Add a ROM to identify it"}
        big={heroShown}
        disabled={busy}
        {...(!hasFiles && expectation ? { hint: "Optional - the match above stands on its own" } : {})}
        guide={WORKFLOW_GUIDES.identify}
        heroLabel={localizer.message("ui.identify.drop")}
        heroLabelCoarse={localizer.message("ui.identify.tap")}
        info={<p>Identification runs locally. Your ROM never leaves this browser.</p>}
        inputId={inputId}
        lead={{
          line1: "ui.hero.identifyThesis",
          line2: "ui.hero.identifyThesis2",
          description: "ui.hero.identifyDescription",
        }}
        onFiles={selectFiles}
        supported={IDENTIFY_SUPPORTED_FILES}
        afterDropZone={
          heroShown ? (
            <RomSearch idPrefix={containerId} localizer={localizer} lookup={romLookup} sampleChecksum="46df91ad" />
          ) : null
        }
      />
      {hasFiles ? (
        <WorkflowRomInputStep
          beforeItems={only && result && !unavailable && result.status === "unknown" ? noMatchNotice(result) : null}
          afterItems={
            <>
              {errorBlock}
              {unavailableBlock}
              {!(unavailable || busy) && entries.some((entry) => !(entry.result || entry.error)) ? (
                <RunButton icon={<RotateCcw aria-hidden="true" />} onClick={retry}>
                  Retry identification
                </RunButton>
              ) : null}
              {entries.map((entry) =>
                entry.result && entry.result.status !== "unavailable" && !entry.result.candidates.length ? (
                  <Notice key={entry.id} level="warn">
                    {entries.length > 1 ? `${entry.file.name}: ` : ""}No ROM was found in this input, so nothing could
                    be identified.
                  </Notice>
                ) : null,
              )}
            </>
          }
          fault={romStepFault}
          items={entries.map((entry, index) => {
            const entryResult = entry.result;
            const ready = !!entryResult && entryResult.status !== "unavailable";
            const entryCandidates = entryResult?.candidates || [];
            const entryTone = ready && entryResult ? IDENTIFY_STATUS_MARK[entryResult.status].tone : undefined;
            const id = index ? `identify-rom-${index + 1}` : "identify-rom";
            if (entry.busy)
              return {
                id,
                progress: {
                  cancelLabel: "Cancel identification",
                  indeterminate: entry.percent == null,
                  label: entry.stage || `Identifying ${entry.file.name}…`,
                  onCancel: () => cancelEntry(entry.id),
                  percent: entry.percent ?? undefined,
                  value: entry.percent == null ? undefined : `${Math.round(entry.percent)}%`,
                },
              };
            return {
              card: {
                children: ready ? (
                  <>
                    {!only && entryResult?.status === "unknown" ? noMatchNotice(entryResult) : null}
                    {entryCandidates.map((candidate) => (
                      <CandidateResult
                        candidate={candidate}
                        {...(only && comparableChecks ? { expected: comparableChecks } : {})}
                        key={candidate.path}
                        showMemberPath={!!entryResult?.archiveName}
                      />
                    ))}
                  </>
                ) : undefined,
                displayName: entry.file.name,
                extract: { fileName: entry.file.name, fileSize: entry.file.size },
                meta: (
                  <>
                    <span className="fsize mono">{formatByteSize(entry.file.size)}</span>
                    {ready && entryResult && entryResult.status !== "unknown" && entryCandidates.length ? (
                      <CandidateStatusChip status={entryResult.status} />
                    ) : null}
                  </>
                ),
                onRemove: () => removeEntry(entry.id),
                removeLabel: "Remove ROM",
                state: (only ? expectationVerdict : undefined) ?? entryTone,
              },
              id,
            };
          })}
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
                identification={romLookup.result?.identification}
                onRemove={romLookup.clear}
                removeLabel="Clear the expected ROM"
              />
              {expectationCheatIdentity ? <IdentifyCheatInspection identity={expectationCheatIdentity} /> : null}
              <RomSearch idPrefix={containerId} localizer={localizer} lookup={romLookup} variant="compact" />
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
      {!busy && (!!expectation || (!!result && !unavailable)) && onSelectTab ? (
        <RelatedStrip entryKey="identify" onSelectTab={onSelectTab} />
      ) : null}
    </section>
  );
};

export { IdentifyForm };
export type { IdentifyFormProps };
