import { invokeRomWeaverWeaveCreateWorker, invokeRomWeaverWeaveParseWorker } from "./wasm-weave-commands.ts";
import { toBundleCreateResult, toBundleParseResult } from "./bundle-runtime.ts";

type WeaveCreateInput = Parameters<typeof invokeRomWeaverWeaveCreateWorker>[0];
type BundleCreateInput = Omit<WeaveCreateInput, "weavePath" | "weaveRomPath" | "noWeaveRom"> & {
  bundlePath?: string;
  bundleRomPath?: string;
  noBundleRom?: boolean;
};
const invokeRomWeaverBundleCreateWorker = async (
  { bundlePath, bundleRomPath, noBundleRom, ...input }: BundleCreateInput,
  onProgress?: Parameters<typeof invokeRomWeaverWeaveCreateWorker>[1],
  onLog?: Parameters<typeof invokeRomWeaverWeaveCreateWorker>[2],
) =>
  toBundleCreateResult(
    await invokeRomWeaverWeaveCreateWorker(
      {
        ...input,
        ...(bundlePath === undefined ? {} : { weavePath: bundlePath }),
        ...(bundleRomPath === undefined ? {} : { weaveRomPath: bundleRomPath }),
        ...(noBundleRom === undefined ? {} : { noWeaveRom: noBundleRom }),
      },
      onProgress,
      onLog,
    ),
  );
const invokeRomWeaverBundleParseWorker = async (
  input: Parameters<typeof invokeRomWeaverWeaveParseWorker>[0],
  onProgress?: Parameters<typeof invokeRomWeaverWeaveParseWorker>[1],
  onLog?: Parameters<typeof invokeRomWeaverWeaveParseWorker>[2],
) => toBundleParseResult(await invokeRomWeaverWeaveParseWorker(input, onProgress, onLog));
export { invokeRomWeaverBundleCreateWorker, invokeRomWeaverBundleParseWorker };
