import { Fragment, type ReactNode } from "react";
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
  // When transform variants (headerless, auto-trimmed…) are present, the base
  // checksums become one of several groups, so they get their own labeled head
  // ("Unchanged") to match - an unlabeled block alongside labeled variants reads
  // as if it belonged to the first variant.
  const variantRows = (checksumVariants || []).filter((variant) => variant.id !== "raw");
  const baseGroupLabel = "Unchanged";
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
      defaultOpen={defaultOpen}
      label={label}
      lead={progress ? <FileProgress {...progress} /> : lead}
      onToggle={onToggle}
      open={open}
      timing={timing}
    >
      {variantRows.length ? (
        <div className="ck-group">
          <div className="ck-group-head">{baseGroupLabel}</div>
          {baseRows}
        </div>
      ) : (
        baseRows
      )}
      <VariantGroups bytes={bytes} variants={checksumVariants} />
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
  SourceInfoList,
  type SourceInfoProgress,
  type TrimFixDetails,
};
