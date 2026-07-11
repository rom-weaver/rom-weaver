import { ROM_WEAVER_PATCH_FORMATS } from "../wasm/generated/rom-weaver-format-metadata.ts";

// Expected leading magic (as a Latin-1 string for `header.startsWith`) per patch
// extension, sourced from the generated patch-format metadata - Rust owns the
// signatures via `PatchHandler::header_magic`. Only formats with a fixed leading
// magic the UI validates against are listed; everything else gets no header check.
const PATCH_HEADER_MAGIC_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  ROM_WEAVER_PATCH_FORMATS.flatMap((format) =>
    format.magic.length
      ? format.extensions.map((extension) => [
          extension.replace(/^\./, "").toLowerCase(),
          String.fromCharCode(...format.magic),
        ])
      : [],
  ),
);

const getExpectedPatchHeaderMagic = (extension: string | null | undefined): string | undefined =>
  extension ? PATCH_HEADER_MAGIC_BY_EXTENSION[extension.toLowerCase()] : undefined;

export { getExpectedPatchHeaderMagic };
