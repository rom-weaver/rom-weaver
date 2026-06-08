import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import { getBaseFileName } from "../../../../lib/input/path-utils.ts";
import { createTiming, formatTiming } from "../../../../lib/progress/timing.ts";
import { formatByteSize } from "../../../../presentation/workflow-presentation.ts";

/**
 * Nested-extraction view. When a ROM/patch came from one or more archives, the
 * final extracted file is shown on its own line and the full archive chain (with
 * sizes, ratio, and timings) lives in a collapsible section. A single,
 * non-nested file renders just its name. Shared by every workflow's file card.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

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
  legacyArchiveClassName?: string;
  legacyFileClassName?: string;
  parentCompressions?: ExtractionParentLevel[];
  timing?: string;
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

const Size = ({ label, rawBytes }: { label?: string; rawBytes?: string }) =>
  label ? (
    <span className="szv" title={rawBytes}>
      {label}
    </span>
  ) : null;

const Level = ({ level, depth, last }: { level: ExtractionLevel; depth: number; last: boolean }) => (
  <div className={join("lvl", `d${depth}`, last && "last")}>
    {depth > 0 ? <span className="tw">&#9492;</span> : null}
    <span className="fn">{level.name}</span>
    <span className="ldr" />
    <span className="m">
      <span className="msz">
        <Size label={level.sizeLabel} rawBytes={level.rawBytes} />
      </span>
      <span className="mt">{level.timing}</span>
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

  // Raw, non-extracted inputs stay compact. Prepared single-level inputs still
  // show the extract summary so timing and metadata remain visible.
  if (levels.length === 1 && !timing) {
    return (
      <div className="chain">
        <div className="lvl d0 last">
          <span className="fn">{last.name}</span>
        </div>
      </div>
    );
  }

  const first = levels[0];
  const sizeText =
    levels.length === 1
      ? (last.sizeLabel ?? "")
      : first?.sizeLabel && last.sizeLabel
        ? `${first.sizeLabel} → ${last.sizeLabel}${formatRatio(first, last)}`
        : "";

  return (
    <>
      <div className="chain">
        <div className="lvl d0 last">
          <span className="fn">{last.name}</span>
        </div>
      </div>
      <details className="cks extract-d">
        <summary className="cks-summary">
          <ChevronRight aria-hidden="true" className="chev" />
          <span className="lab">Extract</span>
          {sizeText ? <span className="ext-size">{sizeText}</span> : null}
          <span className="tm">{timing ? <span className="t">{timing}</span> : null}</span>
        </summary>
        <div className="cks-rows">
          <div className="chain">
            {levels.map((level, index) => (
              <Level depth={index} key={`${index}:${level.name}`} last={index === levels.length - 1} level={level} />
            ))}
          </div>
        </div>
      </details>
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

const ExtractPanel = ({
  decompressionTimeMs,
  fileName,
  fileSize,
  legacyArchiveClassName = "rom-weaver-patch-stack-archive",
  legacyFileClassName,
  parentCompressions,
  timing,
}: ExtractPanelProps) => (
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
    <ExtractionTree
      levels={buildExtractionLevels(fileName, fileSize, parentCompressions)}
      timing={timing ?? formatExtractionElapsedMs(decompressionTimeMs)}
    />
  </>
);

export {
  buildExtractionLevels,
  type ExtractionLevel,
  type ExtractionParentLevel,
  ExtractionTree,
  ExtractPanel,
  type ExtractPanelProps,
};
