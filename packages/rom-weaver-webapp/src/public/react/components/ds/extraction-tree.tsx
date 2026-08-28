import { Archive, ScanSearch } from "lucide-react";
import type { CSSProperties } from "react";
import { getBaseFileName } from "../../../../lib/input/path-utils.ts";
import { createTiming, formatTiming } from "../../../../storage/shared/timing.ts";
import { useUiLocalizer } from "../../settings-context.tsx";
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
  identified?: boolean;
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

const isValidExtractionSize = (value: number | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const formatExtractionSize = (value: number | undefined, formatBytes: (bytes: number) => string) =>
  isValidExtractionSize(value) ? formatBytes(value) : undefined;

const getEntryTotalSize = (entries: ExtractionFileEntry[] | undefined) => {
  if (!entries?.length) return undefined;
  const sizes = entries
    .map((entry) => entry.fileSize)
    .filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  return sizes.length ? sizes.reduce((total, size) => total + size, 0) : undefined;
};

const addMissingLeafSize = (
  levels: ExtractionLevel[],
  fileName: string,
  fileSize: number | undefined,
  formatBytes: (bytes: number) => string,
) => {
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
  return [
    ...levels.slice(0, -1),
    { ...last, sizeBytes: fileSize, sizeLabel: formatExtractionSize(fileSize, formatBytes) },
  ];
};

const buildExtractionLevels = (
  fileName: string,
  fileSize: number | undefined,
  fileEntries: ExtractionFileEntry[] | undefined,
  parentCompressions: ExtractionParentLevel[] | undefined,
  formatBytes: (bytes: number) => string,
): ExtractionLevel[] => {
  const levels: ExtractionLevel[] = (parentCompressions || []).map((entry) => {
    const sizeBytes = entry.sourceSize ?? entry.outputSize;
    return {
      name: entry.fileName,
      sizeBytes,
      sizeLabel: formatExtractionSize(sizeBytes, formatBytes),
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
        sizeLabel: formatExtractionSize(entry.fileSize, formatBytes),
        timing: formatExtractionElapsedMs(entry.decompressionTimeMs),
      })),
    );
    return addMissingLeafSize(levels, fileName, fileSize, formatBytes);
  }
  // Compare by basename: when the chain already ends with the extracted leaf (whose name may carry
  // its full in-archive path), don't append a duplicate bare-basename level for the same file.
  const last = levels.at(-1);
  if (!last || getBaseFileName(last.name) !== getBaseFileName(fileName)) {
    levels.push({
      name: fileName,
      sizeBytes: fileSize,
      sizeLabel: formatExtractionSize(fileSize, formatBytes),
    });
  }
  return addMissingLeafSize(levels, fileName, fileSize, formatBytes);
};

/** Row depth travels twice: `data-depth` selects, `--d` does the indent arithmetic. */
const TreeRow = ({
  level,
  depth,
  leaf,
  last,
}: {
  level: ExtractionLevel;
  depth: number;
  leaf: boolean;
  last: boolean;
}) => (
  <div
    className={join("tree-row", leaf && "is-leaf", last && "is-last")}
    data-depth={depth}
    style={{ "--d": depth } as CSSProperties}
  >
    <span className="tree-name">{level.name}</span>
    <span className="tree-size" data-size-bytes={level.sizeBytes}>
      {level.sizeLabel || ""}
    </span>
    <span className="tree-time">{level.timing || ""}</span>
  </div>
);

/** The row for the file the card is about - the chain's last level, or the archive entry that
 * matches it by basename. The tree lights this one so the accent lands on the extracted file
 * rather than the container it arrived in. */
const findLeafIndex = (levels: ExtractionLevel[], fileName: string) => {
  const base = getBaseFileName(fileName);
  let leaf = levels.length - 1;
  levels.forEach((level, index) => {
    if (getBaseFileName(level.name) === base) leaf = index;
  });
  return leaf;
};

/** True when no later row shares this row's depth, which is where the guide line stops. */
const isLastAtDepth = (depths: number[], index: number) => {
  const depth = depths[index] ?? 0;
  const next = depths.slice(index + 1).find((value) => value <= depth);
  return next === undefined || next < depth;
};

const isCueLevel = (level: ExtractionLevel) => /\.cue$/i.test(level.name);

const formatRatio = (first: ExtractionLevel, last: ExtractionLevel) => {
  if (isCueLevel(last)) return "";
  if (!(isValidExtractionSize(first.sizeBytes) && isValidExtractionSize(last.sizeBytes))) return "";
  if (!(first.sizeBytes && last.sizeBytes)) return "";
  const ratio = Math.round((first.sizeBytes / last.sizeBytes) * 100);
  return Number.isFinite(ratio) ? ` (${ratio}%)` : "";
};

/** The card name line. */
const ExtractName = ({ displayName, fileName, folderPath, identified }: ExtractNameProps) => (
  <div className="nmline" data-file-name={fileName}>
    {/* Assistive technology gets the identified title and full filename; the visible face
        drops the extension because the format badge carries it. */}
    <span className="sr-only">
      {displayName?.trim() ? `${displayName.trim()} — ${fileName}` : fileName}
      {identified ? " — Identified" : ""}
    </span>
    <span
      aria-hidden="true"
      className="nm"
      title={[displayName?.trim(), folderPath ? `${folderPath} › ${fileName}` : fileName].filter(Boolean).join(" — ")}
    >
      {folderPath ? <span className="nm-folder">{folderPath} › </span> : null}
      {displayName?.trim() || getDisplayName(fileName)}
    </span>
    {identified ? (
      <span aria-hidden="true" className="nm-identified" title="Identified">
        <ScanSearch />
      </span>
    ) : null}
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
  const localizer = useUiLocalizer();
  const levels = buildExtractionLevels(fileName, fileSize, fileEntries, parentCompressions, localizer.formatBytes);
  const resolvedTiming = timing ?? formatExtractionElapsedMs(decompressionTimeMs);
  const timingLabel = formatExtractionTimingLabel(resolvedTiming);
  const first = levels[0];
  const last = levels.at(-1);
  if (!last) return null;
  const depths = levels.map((level, index) => level.depth ?? index);
  const leafIndex = findLeafIndex(levels, fileName);
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
  const validOutputSize = isValidExtractionSize(outputSize) ? outputSize : undefined;
  const validSourceSize = isValidExtractionSize(sourceSize) ? sourceSize : undefined;
  const outputSizeLabel = formatExtractionSize(validOutputSize, localizer.formatBytes) || "";
  const ratioText =
    !hasFileEntries && first && last
      ? formatRatio(first, last)
      : validSourceSize && validOutputSize && validOutputSize > 0
        ? ` (${Math.round((validSourceSize / validOutputSize) * 100)}%)`
        : "";
  const sizeReadout = outputSizeLabel ? (
    <DrawerReadout>
      {validSourceSize && validOutputSize && validOutputSize > 0 ? (
        <>
          <span className="extract-size-source">{formatExtractionSize(validSourceSize, localizer.formatBytes)}</span>
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
            depth={depths[index] ?? index}
            key={`${level.name}:${level.sizeBytes ?? ""}:${level.timing ?? ""}`}
            last={isLastAtDepth(depths, index)}
            leaf={index === leafIndex}
            level={level}
          />
        ))}
      </div>
    </Drawer>
  );
};

export { ExtractDrawer, ExtractName, type ExtractPanelProps };
