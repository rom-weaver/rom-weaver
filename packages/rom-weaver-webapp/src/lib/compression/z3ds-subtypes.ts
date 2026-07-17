import { ROM_WEAVER_Z3DS_SUBTYPES } from "../../wasm/generated/rom-weaver-format-metadata.ts";

// The Z3DS subtype table maps a 3DS payload variant between its raw extension, the
// compressed `.z*` extension assigned on create, and the payload's container magic.
// It is the canonical Rust metadata (surfaced via typegen); the `as const` literal
// tuples are widened here so member lookups accept arbitrary string/number inputs.
type Z3dsSubtype = {
  underlyingExtension: string;
  underlyingAliases: readonly string[];
  compressedExtension: string;
  underlyingMagic: readonly number[] | null;
};

const Z3DS_SUBTYPES: readonly Z3dsSubtype[] = ROM_WEAVER_Z3DS_SUBTYPES;

const magicBytesToString = (magic: readonly number[]): string => String.fromCharCode(...magic);

const findByMagic = (magic: string | null | undefined): Z3dsSubtype | undefined =>
  magic
    ? Z3DS_SUBTYPES.find(
        (entry) => entry.underlyingMagic !== null && magicBytesToString(entry.underlyingMagic) === magic,
      )
    : undefined;

/** Raw payload extension (no dot) for a payload container magic, else null. */
const z3dsUnderlyingExtensionForMagic = (magic: string | null | undefined): string | null =>
  findByMagic(magic)?.underlyingExtension ?? null;

/** Compressed (`.z*`) extension for a payload container magic, else null. */
const z3dsCompressedExtensionForMagic = (magic: string | null | undefined): string | null =>
  findByMagic(magic)?.compressedExtension ?? null;

/** Compressed (`.z*`) extension for a raw, alias, or already-compressed extension, else null. */
const z3dsCompressedExtensionForSourceExtension = (extension: string): string | null =>
  Z3DS_SUBTYPES.find(
    (entry) =>
      entry.underlyingExtension === extension ||
      entry.underlyingAliases.includes(extension) ||
      entry.compressedExtension === extension,
  )?.compressedExtension ?? null;

/** Raw payload extension (no dot) for a *specific* compressed subtype extension
 * (`.zcia`/`.zcci`/`.zcxi`/`.z3dsx`); null for the generic `.z3ds` or unknowns. */
const z3dsUnderlyingExtensionForCompressedExtension = (extension: string): string | null =>
  Z3DS_SUBTYPES.find((entry) => entry.underlyingMagic !== null && entry.compressedExtension === extension)
    ?.underlyingExtension ?? null;

/** Whether `extension` is a compressed z3ds-family extension (`zcia`/`zcci`/`zcxi`/`z3dsx`/`z3ds`). */
const isZ3dsCompressedExtension = (extension: string | null | undefined): boolean =>
  !!extension && Z3DS_SUBTYPES.some((entry) => entry.compressedExtension === extension);

export {
  isZ3dsCompressedExtension,
  z3dsCompressedExtensionForMagic,
  z3dsCompressedExtensionForSourceExtension,
  z3dsUnderlyingExtensionForCompressedExtension,
  z3dsUnderlyingExtensionForMagic,
};
