import type { InputParentCompression } from "./input-assets.ts";

// Weave parsing extracts an embedded ROM outside the normal decompression
// path. Key its synthetic weave→ROM breadcrumb by File identity (staging
// rewrites paths) so the card still renders an Extract chain.
//
// Generic `archive` keeps the breadcrumb display-only and out of compression
// inference. WeakMap ties cleanup to the File.
const weaveRomProvenanceByFile = new WeakMap<object, InputParentCompression[]>();

const setWeaveRomProvenance = (romFile: object | undefined, parentCompressions: InputParentCompression[]): void => {
  if (!romFile || parentCompressions.length === 0) return;
  weaveRomProvenanceByFile.set(romFile, parentCompressions);
};

const getWeaveRomProvenance = (romFile: unknown): InputParentCompression[] | undefined => {
  if (!romFile || typeof romFile !== "object") return undefined;
  return weaveRomProvenanceByFile.get(romFile);
};

export { getWeaveRomProvenance, setWeaveRomProvenance };
