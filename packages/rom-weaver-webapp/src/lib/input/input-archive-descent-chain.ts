import type { PatchFileInstance } from "./binary-service.ts";
import type { InputParentCompression } from "./input-assets.ts";
import { getBaseFileName } from "./path-utils.ts";

// Archive-chain assembly for the recursive input descent, split out of the input-archive
// orchestrator. The Rust descent emits one `extract-step` per descended container level; this turns
// those steps (plus the final leaf) into the depth-ordered `parentCompressions` breadcrumb the
// extraction-tree UI renders. Pure: no I/O, no runtime calls.

/** One descended container level captured from the Rust extract-step progress events. */
type DescentExtractStep = {
  depth: number;
  sourceName: string;
  source: string;
  outDir: string;
  outputSize: number;
  format: string;
  /** Wall-clock ms this level took to extract (Rust `extract_step.extract_time_ms`); rendered as the
   * level's per-row time in the extraction tree. */
  extractTimeMs?: number;
};

/**
 * Build the archive chain for the UI. Each level's displayed size is the container's OWN size
 * (depth 0 = the input file, depth N = the output the previous level produced). The displayed name
 * is the path *inside the immediate parent archive*: a full work path relativized against the
 * longest level `out_dir` that contains it (depth 0 is the input archive itself, shown by name). The
 * extracted leaf is appended as the final level for a single payload; cue groups display their
 * primary entry.
 */
const buildDescentParentCompressions = ({
  archiveFile,
  files,
  outputs,
  steps,
}: {
  archiveFile: PatchFileInstance;
  files: PatchFileInstance[];
  outputs: Array<{ path: string }>;
  steps: DescentExtractStep[];
}): InputParentCompression[] => {
  const orderedSteps = [...steps].sort((left, right) => left.depth - right.depth);
  const outDirs = orderedSteps.map((step) => step.outDir).filter(Boolean);
  const inArchivePath = (fullPath: string): string => {
    let longestContainer = "";
    for (const dir of outDirs) {
      if (fullPath.startsWith(`${dir}/`) && dir.length > longestContainer.length) longestContainer = dir;
    }
    return longestContainer ? fullPath.slice(longestContainer.length + 1) : getBaseFileName(fullPath);
  };
  const parentCompressions: InputParentCompression[] = orderedSteps.map((step, index) => {
    const sourceSize = index === 0 ? archiveFile.fileSize : orderedSteps[index - 1]?.outputSize;
    // Depth 0 is the dropped archive itself: show its ORIGINAL name, not the OPFS-staged
    // source path (e.g. "/work/disc-bincue-5.7z"), whose collision-avoidance "-N" suffix
    // would otherwise leak into the disc title and output filename.
    const fileName =
      index === 0 ? getBaseFileName(archiveFile.fileName || step.sourceName) : inArchivePath(step.source);
    return {
      depth: index,
      fileName,
      kind: step.format,
      ...(typeof sourceSize === "number" && sourceSize > 0 ? { sourceSize } : {}),
      ...(step.outputSize > 0 ? { outputSize: step.outputSize } : {}),
      ...(typeof step.extractTimeMs === "number" && Number.isFinite(step.extractTimeMs)
        ? { decompressionTimeMs: step.extractTimeMs }
        : {}),
    };
  });
  // Append the extracted payload itself as the final chain level, showing its path inside its
  // immediate parent archive. Only for a single payload; cue groups display their primary entry.
  const leafOutput = outputs.length === 1 ? outputs[0] : undefined;
  const leafFile = files.length === 1 ? files[0] : undefined;
  if (leafOutput && leafFile) {
    parentCompressions.push({
      depth: parentCompressions.length,
      fileName: inArchivePath(leafOutput.path),
      kind: "rom",
      ...(leafFile.fileSize > 0 ? { sourceSize: leafFile.fileSize } : {}),
    });
  }
  return parentCompressions;
};

export type { DescentExtractStep };
export { buildDescentParentCompressions };
