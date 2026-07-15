import Archive from "lucide-react/dist/esm/icons/archive.js";
import { getBaseFileName } from "../../../../lib/input/path-utils.ts";
import { formatByteSize } from "../../../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../../../storage/shared/timing.ts";
import { join } from "./cx.ts";
import { Drawer, DrawerReadout } from "./drawer.tsx";

/**
 * Nested-extraction view. The extracted file leads as the card's name line;
 * when it came out of one or more archives, the full chain (sizes + timings)
 * lives in a collapsible Extract drawer rendered as the loom tree. Shared by
 * every workflow's file card.
 */

type ExtractionLevel = {
  name: string;
  sizeLabel?: string;
  sizeBytes?: number;
  rawBytes?: string;
  timing?: string;
};

type ExtractionParentLevel = {
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type ExtractPanelProps = {
  decompressionTimeMs?: number;
  fileName: string;
  fileSize?: number;
  /** Folder path within the source archive (e.g. "patches › v1.2"), shown as a
   * muted prefix on the name line. The archive itself is intentionally omitted. */
  folderPath?: string;
  legacyArchiveClassName?: string;
  legacyFileClassName?: string;
  parentCompressions?: ExtractionParentLevel[];
  timing?: string;
};

/** Card display name: basename without the extension (the format badge carries the type). */
const getDisplayName = (fileName: string) => {
  const base = getBaseFileName(fileName) || fileName;
  const withoutExtension = base.replace(/\.[^.]+$/, "");
  return withoutExtension || base;
};

const formatExtractionElapsedMs = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : undefined;

const formatRawByteLabel = (value?: number) =>
  typeof value === "number" && Number.isFinite(value) ? `${Math.floor(value)} B` : undefined;

const buildExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  parentCompressions: ExtractionParentLevel[] | undefined,
): ExtractionLevel[] => {
  const levels: ExtractionLevel[] = (parentCompressions || []).map((entry) => {
    const sizeBytes = entry.sourceSize ?? entry.outputSize;
    return {
      name: entry.fileName,
      sizeBytes,
      sizeLabel: typeof sizeBytes === "number" ? formatByteSize(sizeBytes) : undefined,
      timing: formatExtractionElapsedMs(entry.decompressionTimeMs),
    };
  });
  // Compare by basename: when the chain already ends with the extracted leaf (whose name may carry
  // its full in-archive path), don't append a duplicate bare-basename level for the same file.
  const last = levels[levels.length - 1];
  if (!last || getBaseFileName(last.name) !== getBaseFileName(fileName)) {
    levels.push({
      name: fileName,
      sizeBytes: fileSize,
      sizeLabel: typeof fileSize === "number" ? formatByteSize(fileSize) : undefined,
    });
  }
  return levels;
};

const TreeRow = ({ level, depth }: { level: ExtractionLevel; depth: number }) => (
  <div className={join("tree-row", `d${depth}`)}>
    {depth > 0 ? <span aria-hidden="true" className="tree-elbow" /> : null}
    <span className="tree-name">{level.name}</span>
    <span className="tree-meta">
      <span className="tree-size" title={level.rawBytes}>
        {level.sizeLabel || ""}
      </span>
      <span className="tree-time">{level.timing || ""}</span>
    </span>
  </div>
);

const isCueLevel = (level: ExtractionLevel) => /\.cue$/i.test(level.name);

const formatRatio = (first: ExtractionLevel, last: ExtractionLevel) => {
  if (isCueLevel(last)) return "";
  if (!(first.sizeBytes && last.sizeBytes)) return "";
  const ratio = Math.round((first.sizeBytes / last.sizeBytes) * 100);
  return Number.isFinite(ratio) ? ` (${ratio}%)` : "";
};

const ExtractionTree = ({ levels, timing }: { levels: ExtractionLevel[]; timing?: string }) => {
  if (levels.length === 0) return null;
  const last = levels[levels.length - 1];
  if (!last) return null;

  const nameLine = (
    <div className="nmline">
      <span className="nm">{last.name}</span>
    </div>
  );

  // Raw, non-extracted inputs stay compact. Prepared single-level inputs still
  // show the extract summary so timing and metadata remain visible.
  if (levels.length === 1 && !timing) return nameLine;

  const first = levels[0];
  const sizeText =
    levels.length === 1
      ? (last.sizeLabel ?? "")
      : first?.sizeLabel && last.sizeLabel
        ? `${first.sizeLabel} → ${last.sizeLabel}${formatRatio(first, last)}`
        : "";

  return (
    <>
      {nameLine}
      <Drawer
        bodyClassName="taskbody"
        className="extract-d"
        label="Extract"
        labelIcon={<Archive aria-hidden="true" />}
        readouts={
          <>
            {sizeText ? <DrawerReadout>{sizeText}</DrawerReadout> : null}
            {timing ? <DrawerReadout time>{timing}</DrawerReadout> : null}
          </>
        }
      >
        <div className="tree mono">
          {levels.map((level, index) => (
            <TreeRow depth={index} key={`${index}:${level.name}`} level={level} />
          ))}
        </div>
      </Drawer>
    </>
  );
};

const LegacyExtractionLabel = ({
  archiveClassName,
  archiveEntries,
  className,
  fileName,
  size,
}: {
  archiveClassName: string;
  archiveEntries?: ExtractionParentLevel[];
  className: string;
  fileName: string;
  size?: number;
}) => {
  const sizeLabel = typeof size === "number" ? formatByteSize(size) : "";
  const rawSizeLabel = formatRawByteLabel(size);
  const archiveSize = archiveEntries?.[0]?.sourceSize ?? archiveEntries?.[0]?.outputSize;
  const archiveSizeLabel = typeof archiveSize === "number" ? formatByteSize(archiveSize) : "";
  const archiveRawSizeLabel = formatRawByteLabel(archiveSize);
  return (
    <span className={`${className} sr-only`}>
      <strong>{fileName}</strong>
      {sizeLabel ? <span data-size-bytes={rawSizeLabel}>{sizeLabel}</span> : null}
      {archiveEntries?.length ? (
        <span className={archiveClassName}>
          <strong>{fileName}</strong>
          {archiveSizeLabel ? <span data-size-bytes={archiveRawSizeLabel}> {archiveSizeLabel}</span> : null}
          {archiveEntries.map((entry) => ` ${entry.fileName}`).join("")}
        </span>
      ) : null}
    </span>
  );
};

/** The card name line (plus the legacy sr-only metadata span tests read). */
const ExtractName = ({
  displayName,
  fileName,
  fileSize,
  folderPath,
  legacyArchiveClassName = "rom-weaver-patch-stack-archive",
  legacyFileClassName,
  parentCompressions,
}: Omit<ExtractPanelProps, "decompressionTimeMs" | "timing"> & { displayName?: string }) => (
  <>
    {legacyFileClassName ? (
      <LegacyExtractionLabel
        archiveClassName={legacyArchiveClassName}
        archiveEntries={parentCompressions}
        className={legacyFileClassName}
        fileName={fileName}
        size={fileSize}
      />
    ) : null}
    <div className="nmline">
      {/* assistive tech (and text-based assertions) get the full filename;
          the visible face drops the extension - the format badge carries it */}
      <span className="sr-only">{fileName}</span>
      <span aria-hidden="true" className="nm" title={folderPath ? `${folderPath} › ${fileName}` : fileName}>
        {folderPath ? <span className="nm-folder">{folderPath} › </span> : null}
        {displayName?.trim() || getDisplayName(fileName)}
      </span>
    </div>
  </>
);

/** Just the Extract drawer (no name line) - for cards that render the name separately. */
const ExtractDrawer = ({
  always = false,
  decompressionTimeMs,
  fileName,
  fileSize,
  parentCompressions,
  timing,
}: ExtractPanelProps & { always?: boolean }) => {
  const levels = buildExtractionLevels(fileName, fileSize, parentCompressions);
  const resolvedTiming = timing ?? formatExtractionElapsedMs(decompressionTimeMs);
  // Bundle sessions and in-flight extraction placeholders force the drawer so
  // the card keeps the same structure when extraction metadata lands.
  if (!always && levels.length <= 1 && !resolvedTiming) return null;
  const first = levels[0];
  const last = levels[levels.length - 1];
  if (!last) return null;
  const sizeText =
    levels.length === 1
      ? (last.sizeLabel ?? "")
      : first?.sizeLabel && last.sizeLabel
        ? `${first.sizeLabel} → ${last.sizeLabel}${formatRatio(first, last)}`
        : "";
  return (
    <Drawer
      bodyClassName="taskbody"
      className="extract-d"
      label="Extract"
      labelIcon={<Archive aria-hidden="true" />}
      readouts={
        <>
          {sizeText ? <DrawerReadout>{sizeText}</DrawerReadout> : null}
          {resolvedTiming ? <DrawerReadout time>{resolvedTiming}</DrawerReadout> : null}
        </>
      }
    >
      <div className="tree mono">
        {levels.map((level, index) => (
          <TreeRow depth={index} key={`${index}:${level.name}`} level={level} />
        ))}
      </div>
    </Drawer>
  );
};

export { ExtractDrawer, ExtractionTree, ExtractName, type ExtractPanelProps };
