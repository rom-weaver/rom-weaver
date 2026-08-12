import { Archive } from "lucide-react";
import { getBaseFileName } from "../../../../lib/input/path-utils.ts";
import { formatByteSize } from "../../../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../../../storage/shared/timing.ts";
import { join } from "./cx.ts";
import { Drawer, DrawerReadout } from "./drawer.tsx";

/**
 * Nested-extraction view. The extracted file leads as the card's name line;
 * The full source chain (including a raw file's single level) lives in a
 * collapsible Files drawer rendered as the loom tree. Shared by every
 * workflow's file card.
 */

type ExtractionLevel = {
  depth?: number;
  name: string;
  sizeLabel?: string;
  sizeBytes?: number;
  timing?: string;
};

type ExtractionParentLevel = {
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type ExtractionFileEntry = {
  fileName: string;
  fileSize?: number;
  decompressionTimeMs?: number;
};

type ExtractPanelProps = {
  decompressionTimeMs?: number;
  fileName: string;
  fileSize?: number;
  /** Short file type shown in the Files drawer header. */
  typeLabel?: string;
  /** Folder path within the source archive (e.g. "patches › v1.2"), shown as a
   * muted prefix on the name line. The archive itself is intentionally omitted. */
  folderPath?: string;
  fileEntries?: ExtractionFileEntry[];
  parentCompressions?: ExtractionParentLevel[];
  timing?: string;
};

type ExtractNameProps = Pick<ExtractPanelProps, "fileName" | "folderPath"> & {
  displayName?: string;
};

/** Card display name: basename without the extension (the format badge carries the type). */
const getDisplayName = (fileName: string) => {
  const base = getBaseFileName(fileName) || fileName;
  const withoutExtension = base.replace(/\.[^.]+$/, "");
  return withoutExtension || base;
};

const formatExtractionElapsedMs = (ms?: number) =>
  typeof ms === "number" && Number.isFinite(ms) ? formatTiming(createTiming(ms)) : undefined;

const formatExtractionTimingLabel = (timing?: string) => (timing ? `Extract ${timing}` : undefined);

const getEntryTotalSize = (entries: ExtractionFileEntry[] | undefined) => {
  if (!entries?.length) return undefined;
  const sizes = entries
    .map((entry) => entry.fileSize)
    .filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  return sizes.length ? sizes.reduce((total, size) => total + size, 0) : undefined;
};

const addMissingLeafSize = (levels: ExtractionLevel[], fileName: string, fileSize: number | undefined) => {
  const last = levels.at(-1);
  if (
    !last ||
    getBaseFileName(last.name) !== getBaseFileName(fileName) ||
    typeof last.sizeBytes === "number" ||
    typeof fileSize !== "number" ||
    !Number.isFinite(fileSize)
  ) {
    return levels;
  }
  return [...levels.slice(0, -1), { ...last, sizeBytes: fileSize, sizeLabel: formatByteSize(fileSize) }];
};

const buildExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  fileEntries: ExtractionFileEntry[] | undefined,
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
  if (fileEntries?.length) {
    const depth = levels.length;
    levels.push(
      ...fileEntries.map((entry) => ({
        depth,
        name: entry.fileName,
        sizeBytes: entry.fileSize,
        sizeLabel: typeof entry.fileSize === "number" ? formatByteSize(entry.fileSize) : undefined,
        timing: formatExtractionElapsedMs(entry.decompressionTimeMs),
      })),
    );
    return addMissingLeafSize(levels, fileName, fileSize);
  }
  // Compare by basename: when the chain already ends with the extracted leaf (whose name may carry
  // its full in-archive path), don't append a duplicate bare-basename level for the same file.
  const last = levels.at(-1);
  if (!last || getBaseFileName(last.name) !== getBaseFileName(fileName)) {
    levels.push({
      name: fileName,
      sizeBytes: fileSize,
      sizeLabel: typeof fileSize === "number" ? formatByteSize(fileSize) : undefined,
    });
  }
  return addMissingLeafSize(levels, fileName, fileSize);
};

const TreeRow = ({ level, depth }: { level: ExtractionLevel; depth: number }) => (
  <div className={join("tree-row", `d${depth}`)}>
    {depth > 0 ? <span aria-hidden="true" className="tree-elbow" /> : null}
    <span className="tree-name">{level.name}</span>
    <span className="tree-meta">
      <span className="tree-size" data-size-bytes={level.sizeBytes}>
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

/** The card name line. */
const ExtractName = ({ displayName, fileName, folderPath }: ExtractNameProps) => (
  <div className="nmline" data-file-name={fileName}>
    {/* assistive tech (and text-based assertions) get the full filename;
        the visible face drops the extension - the format badge carries it */}
    <span className="sr-only">{fileName}</span>
    <span
      aria-hidden="true"
      className="nm"
      title={[displayName?.trim(), folderPath ? `${folderPath} › ${fileName}` : fileName].filter(Boolean).join(" — ")}
    >
      {folderPath ? <span className="nm-folder">{folderPath} › </span> : null}
      {displayName?.trim() || getDisplayName(fileName)}
    </span>
  </div>
);

/** Just the Files drawer (no name line) - for cards that render the name separately. */
const ExtractDrawer = ({
  decompressionTimeMs,
  fileName,
  fileSize,
  fileEntries,
  parentCompressions,
  timing,
  typeLabel,
}: ExtractPanelProps) => {
  const levels = buildExtractionLevels(fileName, fileSize, fileEntries, parentCompressions);
  const resolvedTiming = timing ?? formatExtractionElapsedMs(decompressionTimeMs);
  const timingLabel = formatExtractionTimingLabel(resolvedTiming);
  const first = levels[0];
  const last = levels.at(-1);
  if (!last) return null;
  const hasFileEntries = !!fileEntries?.length;
  const typeText = typeLabel?.trim();
  const outputSize = hasFileEntries
    ? typeof fileSize === "number"
      ? fileSize
      : getEntryTotalSize(fileEntries)
    : last.sizeBytes;
  const sourceSize = hasFileEntries
    ? parentCompressions?.length
      ? first?.sizeBytes
      : undefined
    : levels.length > 1
      ? first?.sizeBytes
      : undefined;
  const outputSizeLabel = formatByteSize(outputSize);
  const ratioText =
    !hasFileEntries && first && last
      ? formatRatio(first, last)
      : sourceSize && outputSize && outputSize > 0
        ? ` (${Math.round((sourceSize / outputSize) * 100)}%)`
        : "";
  const sizeReadout = outputSizeLabel ? (
    <DrawerReadout>
      {sourceSize && outputSize && outputSize > 0 ? (
        <>
          <span className="extract-size-source">{formatByteSize(sourceSize)}</span>
          <span aria-hidden="true"> → </span>
          {outputSizeLabel}
          {ratioText}
        </>
      ) : (
        outputSizeLabel
      )}
    </DrawerReadout>
  ) : null;
  return (
    <Drawer
      bodyClassName="taskbody"
      className="extract-d"
      label="Files"
      labelIcon={<Archive aria-hidden="true" />}
      readouts={
        <>
          {sizeReadout}
          {typeText ? <DrawerReadout>{typeText}</DrawerReadout> : null}
          {timingLabel ? <DrawerReadout time>{timingLabel}</DrawerReadout> : null}
        </>
      }
    >
      <div className="tree mono">
        {levels.map((level, index) => (
          <TreeRow
            depth={level.depth ?? index}
            key={`${level.name}:${level.sizeBytes ?? ""}:${level.timing ?? ""}`}
            level={level}
          />
        ))}
      </div>
    </Drawer>
  );
};

export { ExtractDrawer, ExtractName, type ExtractPanelProps };
