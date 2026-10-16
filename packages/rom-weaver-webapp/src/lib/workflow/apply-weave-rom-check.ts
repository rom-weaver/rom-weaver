import type { ChecksumVariant } from "../../types/checksum.ts";
import { getPrimaryInputAsset, type InputAsset } from "../input/input-assets.ts";
import { compareWeaveRomChecks, type WeaveRomVerdict } from "../weave/weave-targets.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

/** A weave's `rom.checks` as `algo=hex` / `size=N` tokens, plus the ROM member they describe. */
type WeaveRomExpectation = { checks: string; member?: string };

/** Hash `algorithms` for one asset; an algorithm that cannot be computed maps to "" (or is absent).
 * A transient failure throws, and the caller retries on its next pass. */
type ComputeAssetChecksums = (asset: InputAsset, algorithms: readonly string[]) => Promise<Record<string, string>>;

/**
 * The file a weave's ROM resolves to, mirroring weave export: the asset on `rom.member` when the
 * weave names one, else the primary input asset. A `rom.member` weave given the bare extracted
 * file (no asset has a member, so there is no archive or disc around it) resolves to that file, as
 * weave apply accepts it: the file is the member.
 */
const resolveWeaveRomAsset = (assets: readonly InputAsset[], member: string | undefined): InputAsset | undefined => {
  if (!member) return getPrimaryInputAsset(assets);
  const named = assets.find((asset) => asset.member === member);
  if (named) return named;
  return assets.some((asset) => asset.member) ? undefined : getPrimaryInputAsset(assets);
};

type WeaveRomCheck = WeaveRomVerdict & {
  assetId?: string;
  /** The staged checksum variant that matched (header-stripped or an N64 byte order), when the
   * raw bytes did not. */
  variant?: string;
};

const isTransformVariant = (variant: ChecksumVariant): boolean => {
  const compatibility = variant.applyCompatibility;
  return (
    compatibility?.removeHeader === true ||
    compatibility?.strip_header === true ||
    !!String(compatibility?.n64ByteOrder || compatibility?.n64_byte_order || "").trim()
  );
};

const variantSize = (variant: ChecksumVariant, rawSize: number): number | undefined => {
  const compatibility = variant.applyCompatibility;
  if (!(compatibility?.removeHeader === true || compatibility?.strip_header === true)) return rawSize;
  const transform = variant.transforms?.removeHeader;
  const stripped =
    transform && typeof transform === "object" ? (transform as { strippedBytes?: unknown }).strippedBytes : undefined;
  return typeof stripped === "number" && Number.isFinite(stripped) ? rawSize - stripped : undefined;
};

/**
 * Verify the supplied ROM against a weave's `rom.checks`, whatever its patches target, as the CLI
 * weave apply does. Staging computes CRC32, MD5 and SHA-1 only; other declared algorithms (such
 * as `weave create --checksum sha256`) are hashed on demand and remembered per file in `computed`.
 * An algorithm that cannot be computed fails verification instead of passing silently, so strict
 * validation still offers its override.
 *
 * The raw bytes are compared first. When they do not match, the staged header-stripped and N64
 * byte-order variants are tried, so a headered SMC or a .v64 dump passes a weave recorded from the
 * headerless .sfc or the .z64. A variant counts only when it answers every declared algorithm.
 * The checks never reach the engine's `--expect-in`; a variant match only supplies the layout for
 * patches without source checks of their own (see the controller's `weaveRomLayout`).
 */
const verifyWeaveRom = async (
  expectation: WeaveRomExpectation,
  assets: readonly InputAsset[],
  computed: WeakMap<object, Record<string, string>>,
  computeChecksums: ComputeAssetChecksums,
): Promise<WeaveRomCheck> => {
  const asset = resolveWeaveRomAsset(assets, expectation.member);
  if (!asset) {
    return expectation.member
      ? {
          message: `The weave's ROM member ${expectation.member} is not in the supplied ROM`,
          missing: [],
          status: "mismatch",
        }
      : { missing: [], status: "unknown" };
  }
  const key = asset.file as object;
  const actual = () => ({
    checksums: { ...getInputAssetChecksums(asset), ...computed.get(key) },
    size: asset.size,
  });
  let verdict = compareWeaveRomChecks(expectation.checks, actual());
  if (verdict.status !== "mismatch" && verdict.missing.length) {
    const values = await computeChecksums(asset, verdict.missing);
    const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => !!value));
    computed.set(key, { ...computed.get(key), ...filled });
    verdict = compareWeaveRomChecks(expectation.checks, actual());
    if (verdict.status !== "mismatch" && verdict.missing.length) {
      verdict = {
        message: `The weave's ROM ${verdict.missing.join(", ")} checksum cannot be computed here, so the ROM cannot be verified`,
        missing: verdict.missing,
        status: "mismatch",
      };
    }
  }
  if (verdict.status === "mismatch") {
    for (const variant of (asset.checksumVariants || []).filter(isTransformVariant)) {
      const size = variantSize(variant, asset.size);
      const variantVerdict = compareWeaveRomChecks(expectation.checks, {
        checksums: variant.checksums,
        ...(size === undefined ? {} : { size }),
      });
      if (variantVerdict.status === "match" && !variantVerdict.missing.length)
        return { assetId: asset.id, missing: [], status: "match", variant: variant.id };
    }
  }
  return { ...verdict, assetId: asset.id };
};

export type { WeaveRomCheck, WeaveRomExpectation };
export { isTransformVariant, resolveWeaveRomAsset, verifyWeaveRom };
