import type { ChecksumVariant } from "../../types/checksum.ts";
import type { InputAsset } from "../input/input-assets.ts";

/** How the ROM's copier header should be handled for a patch apply. `strip` patches the
 * headerless bytes; whether the header returns on the output is the separate
 * output-header setting (auto keeps emulator-required headers, drops copier junk). */
type ApplyHeaderMode = "keep" | "strip";

/** The header decision for a (patch, target ROM) pair. `decided` is true when the patch's
 * required input checksum proves the mode; false means ambiguous (default keep, let the
 * user override). Absent entirely when the ROM has no strippable header. */
type ApplyHeaderResolution = {
  mode: ApplyHeaderMode;
  decided: boolean;
  /** Detected header size in bytes (from the remove-header variant's transform metadata). */
  strippedBytes?: number;
  /** The headerless bytes' crc32, for preflight comparison when mode is `strip`. */
  headerlessCrc32?: string;
  /** The remove-header variant's full checksum map, used as the trusted checksum cache
   * when the apply/validate runs against the stripped bytes. */
  headerlessChecksums?: Record<string, string>;
  /** Whether the engine's output-header `auto` will put this header back on the patched
   * output (emulator-required format headers) or drop it (junk copier headers). */
  retainOnOutput?: boolean;
  /** The ROM's conventional extension with the header present (e.g. ".smc"). */
  headeredExtension?: string;
  /** The ROM's conventional extension without the header (e.g. ".sfc"). */
  headerlessExtension?: string;
};

type HeaderRequirements = {
  sourceCrc32?: string;
  filenameCrc32?: string;
};

const toNormalizedCrc32 = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!normalized) return undefined;
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length <= 8)
    return Number.parseInt(normalized, 16).toString(16).padStart(8, "0");
  if (/^\d+$/.test(normalized)) return (Number.parseInt(normalized, 10) >>> 0).toString(16).padStart(8, "0");
  return undefined;
};

const findRemoveHeaderVariant = (variants: ChecksumVariant[] | undefined): ChecksumVariant | undefined =>
  variants?.find(
    (variant) => variant.applyCompatibility?.removeHeader === true || variant.applyCompatibility?.strip_header === true,
  );

const getVariantStrippedBytes = (variant: ChecksumVariant): number | undefined => {
  const transform = variant.transforms?.removeHeader;
  if (!transform || typeof transform !== "object") return undefined;
  const bytes = (transform as { strippedBytes?: unknown }).strippedBytes;
  return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : undefined;
};

const getVariantRetainOnOutput = (variant: ChecksumVariant): boolean | undefined => {
  const transform = variant.transforms?.removeHeader;
  if (!transform || typeof transform !== "object") return undefined;
  const retain = (transform as { retainOnOutput?: unknown }).retainOnOutput;
  return typeof retain === "boolean" ? retain : undefined;
};

const getVariantExtension = (
  variant: ChecksumVariant,
  key: "headeredExtension" | "headerlessExtension",
): string | undefined => {
  const transform = variant.transforms?.removeHeader;
  if (!transform || typeof transform !== "object") return undefined;
  const extension = (transform as Record<string, unknown>)[key];
  return typeof extension === "string" && extension.startsWith(".") ? extension : undefined;
};

/** Decide the default header handling for a patch against its target ROM, mirroring the
 * CLI's `--patch-header auto` rule: the ROM's checksum variants (already computed at staging)
 * are matched against the patch's required input crc32 (embedded UPS/BPS source crc32,
 * else the filename `[crc32:..]` token). Returns undefined when the ROM has no
 * strippable header - there is nothing header-related to decide or show. */
const resolveApplyHeaderMode = (
  requirements: HeaderRequirements | undefined,
  target: Pick<InputAsset, "checksums" | "checksumVariants">,
): ApplyHeaderResolution | undefined => {
  const variant = findRemoveHeaderVariant(target.checksumVariants);
  if (!variant) return undefined;
  const strippedBytes = getVariantStrippedBytes(variant);
  const headerlessCrc32 = toNormalizedCrc32(variant.checksums?.crc32);
  const retainOnOutput = getVariantRetainOnOutput(variant);
  const headeredExtension = getVariantExtension(variant, "headeredExtension");
  const headerlessExtension = getVariantExtension(variant, "headerlessExtension");
  const base: Omit<ApplyHeaderResolution, "mode" | "decided"> = {
    ...(strippedBytes === undefined ? {} : { strippedBytes }),
    ...(headerlessCrc32 ? { headerlessCrc32 } : {}),
    ...(variant.checksums && Object.keys(variant.checksums).length
      ? { headerlessChecksums: { ...variant.checksums } }
      : {}),
    ...(retainOnOutput === undefined ? {} : { retainOnOutput }),
    ...(headeredExtension ? { headeredExtension } : {}),
    ...(headerlessExtension ? { headerlessExtension } : {}),
  };
  const requiredCrc32 = toNormalizedCrc32(requirements?.sourceCrc32) ?? toNormalizedCrc32(requirements?.filenameCrc32);
  if (!requiredCrc32) return { ...base, decided: false, mode: "keep" };
  const rawCrc32 = toNormalizedCrc32(target.checksums?.crc32);
  if (rawCrc32 && rawCrc32 === requiredCrc32) return { ...base, decided: true, mode: "keep" };
  if (headerlessCrc32 && headerlessCrc32 === requiredCrc32) return { ...base, decided: true, mode: "strip" };
  // The requirement matches neither variant - the apply will likely fail validation
  // either way, so stay on the untouched bytes and let the user override.
  return { ...base, decided: false, mode: "keep" };
};

export { resolveApplyHeaderMode, toNormalizedCrc32 };
