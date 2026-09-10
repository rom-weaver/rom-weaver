export type PatchInputBasis = "auto" | "base" | "previous";
type PatchInputOverride = "base" | "previous" | undefined;

/** Resolve the bundle's shared rule and its per-patch exceptions. Disabled
 * patches do not consume a position in a previous-output chain. */
const resolvePatchInputBasis = ({
  mode,
  override,
  seenEnabled,
}: {
  mode: PatchInputBasis;
  override: PatchInputOverride;
  seenEnabled: number;
}): PatchInputBasis => {
  if (seenEnabled === 0) return "base";
  if (override) return override;
  if (mode !== "previous") return mode;
  return "previous";
};

const resolvePatchInputBases = ({
  disabled,
  mode,
  overrides,
}: {
  disabled?: readonly boolean[];
  mode: PatchInputBasis;
  overrides: readonly PatchInputOverride[];
}): PatchInputBasis[] => {
  let seenEnabled = 0;
  const count = Math.max(overrides.length, disabled?.length || 0);
  return Array.from({ length: count }, (_, index) => {
    const override = overrides[index];
    const enabled = !disabled?.[index];
    const basis = resolvePatchInputBasis({ mode, override, seenEnabled });
    if (enabled) seenEnabled += 1;
    return basis;
  });
};

/** Keep only declarations that differ from the shared Rust command default. */
const patchInputOverridesForRuntime = ({
  disabled,
  mode,
  overrides,
}: {
  disabled?: readonly boolean[];
  mode: PatchInputBasis;
  overrides: readonly PatchInputOverride[];
}): PatchInputBasis[] | undefined => {
  const resolved = resolvePatchInputBases({ disabled, mode, overrides });
  if (!overrides.some(Boolean)) return undefined;
  // `auto` clears the command default. Once a vector is present, base/previous
  // modes must therefore send every resolved position concretely. Auto keeps
  // its untouched positions as auto so Rust can infer those entries.
  return mode === "auto" ? resolved.map((basis, index) => (overrides[index] ? basis : "auto")) : resolved;
};

export { patchInputOverridesForRuntime, resolvePatchInputBases };
