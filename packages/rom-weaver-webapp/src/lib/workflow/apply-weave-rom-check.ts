import { getPrimaryInputAsset, type InputAsset } from "../input/input-assets.ts";
import { compareWeaveRomChecks, type WeaveRomVerdict } from "../weave/weave-targets.ts";
import { getInputAssetChecksums } from "./staged-source-checksums.ts";

/** A weave's `rom.checks` as `algo=hex` / `size=N` tokens, plus the ROM member they describe. */
type WeaveRomExpectation = { checks: string; member?: string };

/** Hash `algorithms` for one asset; an algorithm that could not be computed maps to "". */
type ComputeAssetChecksums = (asset: InputAsset, algorithms: readonly string[]) => Promise<Record<string, string>>;

/**
 * The file a weave's ROM resolves to, mirroring weave export: the asset on `rom.member` when the
 * weave names one, else the primary input asset.
 */
const resolveWeaveRomAsset = (assets: readonly InputAsset[], member: string | undefined): InputAsset | undefined =>
  member ? assets.find((asset) => asset.member === member) : getPrimaryInputAsset(assets);

/**
 * Verify the supplied ROM against a weave's `rom.checks`, whatever its patches target, as the CLI
 * weave apply does. Staging computes CRC32, MD5 and SHA-1 only; other declared algorithms (such
 * as `weave create --checksum sha256`) are hashed on demand and remembered per file in `computed`.
 * An algorithm that cannot be computed fails verification instead of passing silently, so strict
 * validation still offers its override.
 */
const verifyWeaveRom = async (
  expectation: WeaveRomExpectation,
  assets: readonly InputAsset[],
  computed: WeakMap<object, Record<string, string>>,
  computeChecksums: ComputeAssetChecksums,
): Promise<WeaveRomVerdict & { assetId?: string }> => {
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
  return { ...verdict, assetId: asset.id };
};

export type { WeaveRomExpectation };
export { resolveWeaveRomAsset, verifyWeaveRom };
