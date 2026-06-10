import type { ChecksumRomProbe, ChecksumVariant } from "../../types/checksum.ts";
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

type InputAsset = {
  id: string;
  fileName: string;
  kind: "rom" | "cue" | "track";
  size: number;
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  preparation?: InputPreparationMetrics;
  file: PatchFileInstance;
  groupId?: string;
  patchable: boolean;
  disc?: {
    cueText?: string;
    trackNumber?: number;
    mode?: string;
    splitBinAvailable?: boolean;
  };
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
): InputAsset => ({
  disc: { cueText },
  file,
  fileName,
  groupId,
  id,
  kind: "cue",
  patchable: false,
  size: file.fileSize,
});

const makeTrackAsset = (
  id: string,
  fileName: string,
  file: PatchFileInstance,
  groupId: string,
  reference: { trackNumber?: number; mode?: string; patchable?: boolean },
  disc: { cueText?: string; splitBinAvailable?: boolean } = {},
): InputAsset => ({
  disc: {
    cueText: disc.cueText,
    mode: reference.mode,
    splitBinAvailable: disc.splitBinAvailable,
    trackNumber: reference.trackNumber,
  },
  file,
  fileName,
  groupId,
  id,
  kind: "track",
  patchable: reference.patchable !== false,
  size: file.fileSize,
});

const makeRomAsset = (id: string, file: PatchFileInstance): InputAsset => ({
  ...((file as PatchFileInstance & { _chdSplitBinAvailable?: boolean })._chdSplitBinAvailable
    ? { disc: { splitBinAvailable: true } }
    : {}),
  file,
  fileName: file.fileName,
  id,
  kind: "rom",
  patchable: true,
  size: file.fileSize,
});

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

export type { CueCandidateGroup, InputAsset, InputParentCompression, InputPreparationMetrics };
export {
  attachInputPreparationMetrics,
  getInputPreparationMetrics,
  makeCueAsset,
  makeInputCandidateGroup,
  makeInputId,
  makeMissingReferenceWarnings,
  makeRomAsset,
  makeTrackAsset,
};
