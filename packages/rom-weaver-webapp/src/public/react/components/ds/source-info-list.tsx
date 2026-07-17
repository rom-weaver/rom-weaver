import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { Fragment, type ReactNode, useState } from "react";
import { InfoToggle } from "../../../../presentation/react/info-toggle.tsx";
import { formatByteSize } from "../../../../presentation/workflow-presentation.ts";
import type { ChecksumVariant, ExtractTiming } from "../../../../types/checksum.ts";
import { ChecksumList, type ChecksumPendingGroup, ChecksumRow, PendingChecks } from "./checksum-list.tsx";
import { FileProgress } from "./feedback.tsx";

type TrimFixDetails = {
  detected?: boolean;
  mode?: string;
  preservedDownloadPlayCert?: boolean;
  trimmedInputBytes?: number;
};

const getTrimFixLabel = (trim: TrimFixDetails | null | undefined) => {
  if (!trim?.detected) return "";
  const details = [
    typeof trim.trimmedInputBytes === "number" ? formatByteSize(trim.trimmedInputBytes) : "",
    trim.mode ? `mode ${trim.mode}` : "",
    trim.preservedDownloadPlayCert ? "download-play cert preserved" : "",
  ].filter(Boolean);
  return details.length ? `Detected (${details.join(" · ")})` : "Detected";
};

/* Trim padding detail (bytes/mode/cert), shown as a labeled sub-group inside the
   Checks drawer only when trim padding was actually detected. */
const TrimFixGroup = ({ trim }: { trim?: TrimFixDetails | null }) => {
  if (!trim?.detected) return null;
  return (
    <div className="ck-group">
      <div className="ck-group-head">Trim</div>
      <ChecksumRow label="TRIM" value={getTrimFixLabel(trim)} />
    </div>
  );
};

const formatExtractTimingMs = (ms?: number): string | undefined =>
  typeof ms === "number" && Number.isFinite(ms) ? `${Math.round(ms)}ms` : undefined;

/* Decode/checksum/overlap split for the extract that produced this file, shown as a
   labeled sub-group inside the same Checks drawer as the checksums. */
const ExtractTimingGroup = ({ timing }: { timing?: ExtractTiming }) => {
  if (!timing) return null;
  const decode = formatExtractTimingMs(timing.decodeMs);
  const checksum = formatExtractTimingMs(timing.checksumMs);
  const overlap = formatExtractTimingMs(timing.overlapMs);
  const total = formatExtractTimingMs(timing.totalMs);
  if (!(decode || checksum || overlap)) return null;
  const head = timing.threaded && timing.workers ? `Extract timing (${timing.workers} threads)` : "Extract timing";
  return (
    <div className="ck-group">
      <div className="ck-group-head">{head}</div>
      {decode ? <ChecksumRow label="DECODE" value={decode} /> : null}
      {checksum ? <ChecksumRow label="CHECKSUM" value={checksum} /> : null}
      {overlap ? <ChecksumRow label="OVERLAP" value={overlap} /> : null}
      {total ? <ChecksumRow label="TOTAL" value={total} /> : null}
    </div>
  );
};

type SourceInfoChecksums = {
  crc32?: string;
  md5?: string;
  sha1?: string;
};

/** What a bundle expects this file to be (its rom/chain-input checks). */
type SourceInfoExpectedChecks = {
  checksums?: Record<string, string>;
  size?: number;
};

const EXPECTED_CHECK_LABELS: Record<string, string> = { crc32: "CRC32", md5: "MD5", sha1: "SHA-1" };

const expectedRowMark = (expected: string, computed: string | undefined): "bad" | "ok" | undefined => {
  const actual = (computed || "").trim().toLowerCase();
  if (!actual) return undefined;
  return actual === expected.trim().toLowerCase() ? "ok" : "bad";
};

const expectedSizeMark = (expectedSize: string, computedBytes: string): "bad" | "ok" | undefined => {
  if (!computedBytes) return undefined;
  return computedBytes === expectedSize ? "ok" : "bad";
};

/* At least one expected field was actually compared and disagreed - the
   header-level "this is not the expected ROM" signal. */
const hasExpectedMismatch = (
  expected: SourceInfoExpectedChecks,
  checksums: SourceInfoChecksums | null | undefined,
  computedBytes: string,
): boolean => {
  for (const [algorithm, value] of Object.entries(expected.checksums || {})) {
    if (!value) continue;
    const actual = checksums?.[algorithm as keyof SourceInfoChecksums];
    if (actual && actual.trim().toLowerCase() !== value.trim().toLowerCase()) return true;
  }
  return typeof expected.size === "number" && !!computedBytes && computedBytes !== String(expected.size);
};

/** Drawer-header ✗ for a failed expectation - click for what it means. */
const ExpectedMismatchInfo = () => (
  <InfoToggle
    ariaLabel="Not the expected ROM"
    className="expected-mismatch-info"
    icon={<X aria-hidden="true" />}
    panelClassName="dry-apply-pop"
    portalPanel
    title="Not the expected ROM"
  >
    <strong>Not the expected ROM</strong>
    <p>This ROM's checks do not match what the bundle was authored against - see the Expected rows below.</p>
    <p>You can still weave, but the result may differ from what the bundle's author intended.</p>
  </InfoToggle>
);

/** One computed hash set the expectation can match: the base checksums or a
 * transform variant's. */
type ComputedCheckSet = { byteValue: string; checksums?: SourceInfoChecksums | null; id: string; label: string };

/* The expectation matches a computed set when every expected field that the
   set can answer agrees, and at least one field was actually compared. */
const matchesExpected = (expected: SourceInfoExpectedChecks, set: ComputedCheckSet): boolean => {
  let compared = 0;
  for (const [algorithm, value] of Object.entries(expected.checksums || {})) {
    if (!value) continue;
    const actual = set.checksums?.[algorithm as keyof SourceInfoChecksums];
    if (!actual) continue;
    compared += 1;
    if (actual.trim().toLowerCase() !== value.trim().toLowerCase()) return false;
  }
  if (typeof expected.size === "number" && set.byteValue) {
    compared += 1;
    if (set.byteValue !== String(expected.size)) return false;
  }
  return compared > 0;
};

/* When the expectation matches, the drawer collapses to this ONE group: the
   expected values with their verified marks, filled out with the matched set's
   remaining hashes - no duplicate Computed group, no other variants. */
const MatchedExpectedGroup = ({
  expected,
  matched,
}: {
  expected: SourceInfoExpectedChecks;
  matched: ComputedCheckSet;
}) => {
  const expectedChecksums = expected.checksums || {};
  const expectedSize = typeof expected.size === "number" ? String(expected.size) : "";
  const rowValue = (algorithm: keyof SourceInfoChecksums) =>
    expectedChecksums[algorithm] || matched.checksums?.[algorithm] || "";
  const rowMark = (algorithm: string) => (expectedChecksums[algorithm] ? "ok" : undefined);
  const byteValue = expectedSize || matched.byteValue;
  return (
    <div className="ck-group" id="rom-weaver-rom-expected-checks">
      <div className="ck-group-head">
        {matched.label}
        <span className="ck-mark ok" title="The staged ROM matches the bundle's expectation">
          <Check aria-hidden="true" />
          <span className="sr-only">matches</span>
        </span>
        <span className="ck-head-note">Expected</span>
      </div>
      {rowValue("crc32") ? <ChecksumRow label="CRC32" mark={rowMark("crc32")} value={rowValue("crc32")} /> : null}
      {byteValue ? (
        <ChecksumRow copyValue={byteValue} label="BYTES" mark={expectedSize ? "ok" : undefined} value={byteValue} />
      ) : null}
      {rowValue("md5") ? <ChecksumRow label="MD5" mark={rowMark("md5")} value={rowValue("md5")} /> : null}
      {rowValue("sha1") ? <ChecksumRow label="SHA-1" mark={rowMark("sha1")} value={rowValue("sha1")} /> : null}
    </div>
  );
};

/* After a satisfied expectation, the remaining computed sets (the base rows
   and the other transform variants) stay available but fold behind a quiet
   disclosure - the match already answered the question they exist for. */
const CollapsedVariantGroups = ({
  baseLabel,
  baseRows,
  bytes,
  variants,
}: {
  baseLabel?: string;
  baseRows?: ReactNode;
  bytes?: number;
  variants: ChecksumVariant[];
}) => {
  const [open, setOpen] = useState(false);
  const count = (baseRows ? 1 : 0) + variants.length;
  if (!count) return null;
  return (
    <>
      <button aria-expanded={open} className="ck-more" onClick={() => setOpen(!open)} type="button">
        <ChevronRight aria-hidden="true" className="chev-i" />
        {open ? "Hide" : "Show"} {count} more {count === 1 ? "variant" : "variants"}
      </button>
      {open ? (
        <>
          {baseRows ? (
            <div className="ck-group">
              <div className="ck-group-head">{baseLabel}</div>
              {baseRows}
            </div>
          ) : null}
          <VariantGroups bytes={bytes} variants={variants} />
        </>
      ) : null}
    </>
  );
};

/* The bundle's expected-ROM rows inside the same Checks drawer, each carrying a
   per-row match/mismatch mark against the computed checksums - so the
   expectation survives the ghost card once the real ROM is staged. */
const ExpectedChecksGroup = ({
  bytes,
  checksums,
  expected,
  mismatch,
}: {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  expected?: SourceInfoExpectedChecks;
  /** A compared field disagreed: the head carries the ✗ / "No match" verdict. */
  mismatch?: boolean;
}) => {
  const expectedChecksums = expected?.checksums || {};
  const expectedSize = typeof expected?.size === "number" ? String(expected.size) : "";
  if (!(Object.keys(expectedChecksums).length || expectedSize)) return null;
  const computedBytes = typeof bytes === "number" && Number.isFinite(bytes) ? String(Math.floor(bytes)) : "";
  // CRC32 then BYTES first so the two short ck-half rows pair on one grid row.
  const orderedAlgorithms = ["crc32", "md5", "sha1", ...Object.keys(expectedChecksums).sort()].filter(
    (algorithm, index, all) => expectedChecksums[algorithm] && all.indexOf(algorithm) === index,
  );
  return (
    <div className="ck-group" id="rom-weaver-rom-expected-checks">
      <div className="ck-group-head">
        Expected
        {mismatch ? (
          <>
            <span className="ck-mark bad" title="This ROM does not match the bundle's expectation">
              <X aria-hidden="true" />
            </span>
            <span className="ck-head-note">No match</span>
          </>
        ) : null}
      </div>
      {orderedAlgorithms.map((algorithm) => (
        <Fragment key={algorithm}>
          <ChecksumRow
            label={EXPECTED_CHECK_LABELS[algorithm] || algorithm.toUpperCase()}
            mark={expectedRowMark(
              expectedChecksums[algorithm] || "",
              checksums?.[algorithm as keyof SourceInfoChecksums],
            )}
            value={expectedChecksums[algorithm] || ""}
          />
          {algorithm === "crc32" && expectedSize ? (
            <ChecksumRow
              copyValue={expectedSize}
              label="BYTES"
              mark={expectedSizeMark(expectedSize, computedBytes)}
              value={expectedSize}
            />
          ) : null}
        </Fragment>
      ))}
      {!expectedChecksums.crc32 && expectedSize ? (
        <ChecksumRow
          copyValue={expectedSize}
          label="BYTES"
          mark={expectedSizeMark(expectedSize, computedBytes)}
          value={expectedSize}
        />
      ) : null}
    </div>
  );
};

type SourceInfoProgress = Parameters<typeof FileProgress>[0];

const CHECKSUM_VARIANT_ALGORITHMS = [
  ["crc32", "CRC32"],
  ["md5", "MD5"],
  ["sha1", "SHA-1"],
] as const;

const getVariantStrippedBytes = (variant: ChecksumVariant): number => {
  const removeHeader = (variant.transforms as { removeHeader?: { strippedBytes?: unknown } } | undefined)?.removeHeader;
  const stripped = removeHeader?.strippedBytes;
  return typeof stripped === "number" && Number.isFinite(stripped) ? stripped : 0;
};

// remove-header drops the leading header bytes; the other transforms keep the
// byte count, so the variant's size is the source size minus any stripped header.
const getVariantBytes = (variant: ChecksumVariant, sourceBytes: number | undefined): string => {
  if (typeof sourceBytes !== "number" || !Number.isFinite(sourceBytes)) return "";
  const stripped = variant.id === "remove-header" ? getVariantStrippedBytes(variant) : 0;
  return String(Math.max(0, Math.floor(sourceBytes) - stripped));
};

/* Checksum variants (headerless, auto-trimmed…) render as labeled sub-groups
   inside the same Checks drawer as the raw checksums - the prototype's single
   "Checks" section, not a separate drawer. */
const VariantGroups = ({ bytes, variants }: { bytes?: number; variants?: ChecksumVariant[] }) => {
  const rows = (variants || []).filter((variant) => variant.id !== "raw");
  if (!rows.length) return null;
  return (
    <>
      {rows.map((variant) => {
        const byteValue = getVariantBytes(variant, bytes);
        return (
          <div className="ck-group" key={variant.id}>
            <div className="ck-group-head">{variant.label}</div>
            {CHECKSUM_VARIANT_ALGORITHMS.map(([algorithm, algorithmLabel]) => {
              const value = variant.checksums?.[algorithm] || "";
              if (!value) return null;
              return (
                <Fragment key={algorithm}>
                  <ChecksumRow label={algorithmLabel} value={value} />
                  {/* BYTES pairs with CRC32 on one wide-drawer grid row */}
                  {algorithm === "crc32" && byteValue ? (
                    <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} />
                  ) : null}
                </Fragment>
              );
            })}
            {!variant.checksums?.crc32 && byteValue ? (
              <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} />
            ) : null}
          </div>
        );
      })}
    </>
  );
};

const SourceInfoList = ({
  bytes,
  checksums,
  checksumVariants,
  defaultOpen = false,
  expected,
  extractTiming,
  label = "Checks",
  lead,
  onToggle,
  open,
  pending,
  progress,
  timing,
  trim,
}: {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  checksumVariants?: ChecksumVariant[];
  defaultOpen?: boolean;
  /** Bundle-expected checks for this file, rendered as an "Expected" group with
   * per-row match marks against the computed values. */
  expected?: SourceInfoExpectedChecks;
  extractTiming?: ExtractTiming;
  /** Section heading; defaults to "Checks". Disc cards pass the track filename. */
  label?: string;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  /** When set, the file is still staging: render shimmer placeholders for these
   * planned groups/rows (reserving the resolved height) instead of any value. */
  pending?: ChecksumPendingGroup[];
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
  /** Trim-padding probe; surfaces a "Trim" group only when padding is detected. */
  trim?: TrimFixDetails | null;
}) => {
  if (pending?.length) {
    return <PendingChecks defaultOpen={defaultOpen} groups={pending} label={label} onToggle={onToggle} open={open} />;
  }
  const hasBytes = typeof bytes === "number" && Number.isFinite(bytes);
  if (!(hasBytes || checksums || lead || progress || trim?.detected)) return null;
  const byteValue = hasBytes ? String(Math.floor(bytes as number)) : "";
  const hasExpected = !!(Object.keys(expected?.checksums || {}).length || typeof expected?.size === "number");
  // When transform variants (headerless, auto-trimmed…) are present - or the
  // bundle contributes an "Expected" group - the base checksums become one of
  // several groups, so they get their own labeled head ("Unchanged"/"Computed")
  // to match - an unlabeled block alongside labeled groups reads as if it
  // belonged to the first one.
  const variantRows = (checksumVariants || []).filter((variant) => variant.id !== "raw");
  const baseGroupLabel = variantRows.length ? "Unchanged" : "Computed";
  // A satisfied expectation collapses the drawer to a single verified group -
  // repeating the same hashes as "Computed" (and listing the other transform
  // variants) would only restate what the match already settled.
  const expectedMatch = hasExpected
    ? [
        { byteValue, checksums, id: "base", label: baseGroupLabel },
        ...variantRows.map((variant) => ({
          byteValue: getVariantBytes(variant, bytes),
          checksums: variant.checksums,
          id: variant.id,
          label: variant.label,
        })),
      ].find((set) => matchesExpected(expected as SourceInfoExpectedChecks, set))
    : undefined;
  const expectedMismatch =
    hasExpected && !expectedMatch && hasExpectedMismatch(expected as SourceInfoExpectedChecks, checksums, byteValue);
  // BYTES rides directly after CRC32 - the two short rows pair onto one grid
  // row in wide drawers, so they stay adjacent in the DOM.
  const baseRows = (
    <>
      <ChecksumRow label="CRC32" value={checksums?.crc32 || ""} />
      <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} />
      <ChecksumRow label="MD5" value={checksums?.md5 || ""} />
      <ChecksumRow label="SHA-1" value={checksums?.sha1 || ""} />
    </>
  );
  return (
    <ChecksumList
      action={expectedMismatch ? <ExpectedMismatchInfo /> : undefined}
      defaultOpen={defaultOpen}
      label={label}
      lead={progress ? <FileProgress {...progress} /> : lead}
      onToggle={onToggle}
      open={open}
      timing={timing}
    >
      {expectedMatch ? (
        <>
          <MatchedExpectedGroup expected={expected as SourceInfoExpectedChecks} matched={expectedMatch} />
          <CollapsedVariantGroups
            baseLabel={expectedMatch.id === "base" ? undefined : baseGroupLabel}
            baseRows={expectedMatch.id === "base" ? undefined : baseRows}
            bytes={bytes}
            variants={variantRows.filter((variant) => variant.id !== expectedMatch.id)}
          />
        </>
      ) : (
        <>
          {variantRows.length || hasExpected ? (
            <div className="ck-group">
              <div className="ck-group-head">{baseGroupLabel}</div>
              {baseRows}
            </div>
          ) : (
            baseRows
          )}
          {hasExpected ? (
            <ExpectedChecksGroup bytes={bytes} checksums={checksums} expected={expected} mismatch={expectedMismatch} />
          ) : null}
          <VariantGroups bytes={bytes} variants={checksumVariants} />
        </>
      )}
      <TrimFixGroup trim={trim} />
      <ExtractTimingGroup timing={extractTiming} />
    </ChecksumList>
  );
};

/** One track's data inside a disc's unified "Tracks" section. */
type DiscTrackPanelInfo = {
  id: string;
  label: string;
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  timing?: ReactNode;
  progress?: SourceInfoProgress | null;
};

/**
 * A multi-track disc's per-bin checksums under a single collapsible
 * "Checks & Tracks" section - each track is a labeled sub-group rather than its
 * own top-level panel, so the tracks read as one unit. This is the disc form of
 * the single-file "Checks" panel: it carries the checksums, just grouped by
 * track, so a disc card has no separate Checks drawer.
 */
const DiscTracksPanel = ({
  tracks,
  open,
  onToggle,
}: {
  tracks: DiscTrackPanelInfo[];
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) => {
  if (!tracks.length) return null;
  return (
    <ChecksumList defaultOpen={false} label="Checks & Tracks" onToggle={onToggle} open={open}>
      {tracks.map((track) => {
        const hasBytes = typeof track.bytes === "number" && Number.isFinite(track.bytes);
        const byteValue = hasBytes ? String(Math.floor(track.bytes as number)) : "";
        return (
          <div className="ck-group" key={track.id}>
            <div className="ck-group-head">
              {track.label}
              {track.timing ? <span className="t"> {track.timing}</span> : null}
            </div>
            {track.progress ? <FileProgress {...track.progress} /> : null}
            {track.checksums?.crc32 ? <ChecksumRow label="CRC32" value={track.checksums.crc32} /> : null}
            {byteValue ? <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} /> : null}
            {track.checksums?.md5 ? <ChecksumRow label="MD5" value={track.checksums.md5} /> : null}
            {track.checksums?.sha1 ? <ChecksumRow label="SHA-1" value={track.checksums.sha1} /> : null}
          </div>
        );
      })}
    </ChecksumList>
  );
};

export {
  type ChecksumPendingGroup,
  type DiscTrackPanelInfo,
  DiscTracksPanel,
  type SourceInfoChecksums,
  type SourceInfoExpectedChecks,
  SourceInfoList,
  type SourceInfoProgress,
  type TrimFixDetails,
};
