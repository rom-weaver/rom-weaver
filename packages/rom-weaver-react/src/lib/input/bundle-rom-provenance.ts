import type { InputParentCompression } from "./input-assets.ts";

// A ROM shipped inside a rom-weaver-bundle is pulled out of the bundle archive out-of-band by the
// bundle parse (it arrives as a bare, already-extracted File), so it never flows through the
// input-decompression extract pass that populates the "Extract" drawer for a plainly-dropped archive.
// Without help its ROM card would render with no extract section, while the identical ROM dropped inside
// a plain `.zip` shows the archive -> rom chain. Stash the synthesized bundle -> rom breadcrumb here,
// keyed by the extracted ROM's File object (the input pipeline re-paths the staged copy, so the OPFS
// path is not a stable key - the File identity is), so ROM preparation can attach the same
// `parentCompressions` chain and both paths render the extract section identically.
//
// The breadcrumb uses the generic "archive" kind so it stays display-only: only the zip/7z/chd/rvz/z3ds
// parent kinds drive automatic output-compression inference, so a bundle's internal packaging never
// changes the user's chosen output format. The WeakMap lets an abandoned ROM's entry be collected with
// the File - no explicit teardown needed.
const bundleRomProvenanceByFile = new WeakMap<object, InputParentCompression[]>();

const setBundleRomProvenance = (romFile: object | undefined, parentCompressions: InputParentCompression[]): void => {
  if (!romFile || parentCompressions.length === 0) return;
  bundleRomProvenanceByFile.set(romFile, parentCompressions);
};

const getBundleRomProvenance = (romFile: unknown): InputParentCompression[] | undefined => {
  if (!romFile || typeof romFile !== "object") return undefined;
  return bundleRomProvenanceByFile.get(romFile);
};

export { getBundleRomProvenance, setBundleRomProvenance };
