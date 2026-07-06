import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "../../types/checksum.ts";
import type { SelectionGroupCandidate } from "../../types/selection.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";

type InputParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type InputPreparationMetrics = {
  decompressionTimeMs?: number;
  parentCompressions?: InputParentCompression[];
  sourceSize?: number;
  wasDecompressed?: boolean;
};

// A sidecar patch ingest extracted from the same ROM-bearing archive, harvested off the single
// ROM-staging `ingest` pass (no separate scan). The host surfaces these for the user to apply
// (interactive) or auto-applies the name-matched ones (`sidecarOrder` set) headlessly.
type PreparedSidecarPatch = {
  file: PatchFileInstance;
  parentCompressions: InputParentCompression[];
  sidecarOrder?: number;
};

type InputAsset = {
  id: string;
  fileName: string;
  kind: "rom" | "cue" | "gdi" | "track";
  size: number;
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  preparation?: InputPreparationMetrics;
  file: PatchFileInstance;
  groupId?: string;
  patchable: boolean;
  // Sidecar patches bundled alongside this ROM in the source archive, harvested from the same ingest
  // pass that produced this asset. Set on the primary ROM asset of a mixed ROM+patch archive only.
  sidecarPatches?: PreparedSidecarPatch[];
};
type CueCandidateGroup = SelectionGroupCandidate & {
  cueFileName: string;
  missingReferences: string[];
  patchable: boolean;
  trackFileNames: string[];
};

const makeInputId = (
  sourceIndex: number,
  fileName: string,
  normalizeFileName: (fileName: string) => string,
  suffix = "",
) =>
  `input-${sourceIndex}-${
    normalizeFileName(fileName)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "asset"
  }${suffix}`;

const makeCueAsset = (
  id: string,
  fileName: string,
  file: PatchFileInstance,
  groupId: string,
  cueText: string,
): InputAsset => {
  file.metadata = { ...file.metadata, ...(cueText ? { cueText } : {}) };
  return {
    file,
    fileName,
    groupId,
    id,
    kind: "cue",
    patchable: false,
    size: file.fileSize,
  };
};

// A GD-ROM ships a `.gdi` sheet instead of (or alongside) a `.cue`. It is a
// non-patchable disc sidecar like the cue, so it groups with its tracks and is
// excluded from checksums, but its text lives in `metadata.gdiText` so the UI renders
// it in a separate GDI panel rather than the CUE panel.
const makeGdiAsset = (
  id: string,
  fileName: string,
  file: PatchFileInstance,
  groupId: string,
  gdiText: string,
): InputAsset => {
  file.metadata = { ...file.metadata, ...(gdiText ? { gdiText } : {}) };
  return {
    file,
    fileName,
    groupId,
    id,
    kind: "gdi",
    patchable: false,
    size: file.fileSize,
  };
};

const makeTrackAsset = (
  id: string,
  fileName: string,
  file: PatchFileInstance,
  groupId: string,
  reference: { trackNumber?: number; mode?: string; patchable?: boolean },
  disc: { cueText?: string; gdiText?: string; splitBinAvailable?: boolean } = {},
): InputAsset => {
  // `reference.mode`/`reference.trackNumber` (cue track mode + reference order) are never read and
  // would collide with `SourceMetadata.mode`/`trackNumber`, so they are intentionally not folded.
  file.metadata = {
    ...file.metadata,
    ...(disc.cueText ? { cueText: disc.cueText } : {}),
    ...(disc.gdiText ? { gdiText: disc.gdiText } : {}),
    ...(typeof disc.splitBinAvailable === "boolean" ? { splitBinAvailable: disc.splitBinAvailable } : {}),
  };
  return {
    file,
    fileName,
    groupId,
    id,
    kind: "track",
    patchable: reference.patchable !== false,
    size: file.fileSize,
  };
};

const makeRomAsset = (id: string, file: PatchFileInstance): InputAsset => {
  if ((file as PatchFileInstance & { _chdSplitBinAvailable?: boolean })._chdSplitBinAvailable)
    file.metadata = { ...file.metadata, splitBinAvailable: true };
  return {
    file,
    fileName: file.fileName,
    id,
    kind: "rom",
    patchable: true,
    size: file.fileSize,
  };
};

const makeInputCandidateGroup = ({
  groupId,
  cueFileName,
  trackFileNames,
  missingReferences,
  patchable,
  breadcrumbs,
  path,
}: {
  groupId: string;
  cueFileName: string;
  trackFileNames: string[];
  missingReferences: string[];
  patchable: boolean;
  breadcrumbs?: string[];
  path?: string;
}): CueCandidateGroup => ({
  breadcrumbs,
  candidateIds: [],
  cueFileName,
  id: groupId,
  kind: "cue-disc",
  label: cueFileName,
  missingReferences,
  patchable,
  path,
  selectable: patchable,
  trackFileNames,
  type: "group",
  warnings: missingReferences.map((fileName) => `${cueFileName} references missing file: ${fileName}`),
});

const makeMissingReferenceWarnings = (cueFileName: string, missingReferences: string[]) =>
  missingReferences.length ? [`${cueFileName} references missing file(s): ${missingReferences.join(", ")}`] : [];

const attachInputPreparationMetrics = (
  assets: InputAsset[],
  preparation: InputPreparationMetrics | undefined,
): InputAsset[] => {
  if (!preparation) return assets;
  return assets.map((asset) => ({
    ...asset,
    preparation: { ...preparation },
  }));
};

const getInputPreparationMetrics = (assets: InputAsset[]): InputPreparationMetrics | undefined =>
  assets.find((asset) => asset.preparation)?.preparation;

export type { InputAsset, InputParentCompression, PreparedSidecarPatch };
export {
  attachInputPreparationMetrics,
  getInputPreparationMetrics,
  makeCueAsset,
  makeGdiAsset,
  makeInputCandidateGroup,
  makeInputId,
  makeMissingReferenceWarnings,
  makeRomAsset,
  makeTrackAsset,
};
