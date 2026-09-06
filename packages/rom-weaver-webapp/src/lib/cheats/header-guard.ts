/**
 * Cheat offsets are computed against the original ROM bytes, header included,
 * so stripping the header moves every baked write. The CLI refuses `--code`
 * with header stripping; the webapp derives the same rule from the two places
 * a strip can be pinned - the per-patch header select in 0x03 and the output
 * header control in 0x05.
 */

type HeaderMode = "auto" | "keep" | "strip" | undefined;

/** Title/description on a strip option the cheat stack has taken away. */
export const CHEAT_HEADER_STRIP_HINT =
  "Cheats bake into the original ROM bytes, header included, so they need it kept.";

/** Validation message shown in the Cheats step while a strip is still pinned. */
export const CHEAT_HEADER_STRIP_MESSAGE = "Turn cheats off or set ROM header handling back to keep.";

/**
 * The Cheats-step validation message, or "" when nothing conflicts. Only an
 * explicit "strip" pin conflicts; "auto" is the engine's own decision and is
 * left alone.
 */
export const getCheatHeaderStripConflict = ({
  cheatsOn,
  outputHeader,
  patchHeaderModes,
}: {
  /** At least one cheat card's switch is On. */
  cheatsOn: boolean;
  outputHeader?: HeaderMode;
  patchHeaderModes?: readonly HeaderMode[];
}): string => {
  if (!cheatsOn) return "";
  const stripped = outputHeader === "strip" || (patchHeaderModes || []).some((mode) => mode === "strip");
  return stripped ? CHEAT_HEADER_STRIP_MESSAGE : "";
};
