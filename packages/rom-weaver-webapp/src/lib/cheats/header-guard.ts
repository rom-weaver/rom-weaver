/**
 * Cheat offsets are computed against the original ROM bytes, header included,
 * so stripping the header before a patch moves every baked write. The CLI
 * refuses `--code` with `--patch-header strip`; the webapp derives the same
 * rule from the per-patch header select in 0x03. The output header in 0x05 is
 * applied after the cheats bake and is not part of the rule.
 */

type HeaderMode = "auto" | "keep" | "strip" | undefined;

/** Title/description on a strip option the cheat stack has taken away. */
export const CHEAT_HEADER_STRIP_HINT =
  "Cheats bake into the original ROM bytes, header included, so they need it kept.";

/** Validation message shown in the Cheats step while a strip is still pinned. */
export const CHEAT_HEADER_STRIP_MESSAGE = "Turn cheats off or set ROM header handling back to keep.";

/**
 * The Cheats-step validation message, or "" when nothing conflicts. Callers
 * MUST pass the mode the run will send: an explicit pin, or a decided auto
 * resolution; an undecided "auto" is the engine's own decision and is left
 * alone.
 */
export const getCheatHeaderStripConflict = ({
  cheatsOn,
  patchHeaderModes,
}: {
  /** At least one ROM-bakeable cheat card's switch is On. */
  cheatsOn: boolean;
  patchHeaderModes?: readonly HeaderMode[];
}): string => {
  if (!cheatsOn) return "";
  const stripped = (patchHeaderModes || []).some((mode) => mode === "strip");
  return stripped ? CHEAT_HEADER_STRIP_MESSAGE : "";
};
