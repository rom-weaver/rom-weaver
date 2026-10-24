import type { ParsedBundleCreateResult, ParsedBundleParseResult } from "../../types/bundle.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ParsedWeaveCreateResult, ParsedWeaveParseResult } from "../../types/weave.ts";

type WeaveRuntime = NonNullable<WorkflowRuntime["weave"]>;
type BundleRuntime = NonNullable<WorkflowRuntime["bundle"]>;
type RuntimeMethod = (input: object) => Promise<{ result: object }>;

const renameFields = <T extends object>(input: object, legacy = true): T => {
  const output: Record<string, unknown> = { ...input };
  for (const [weave, bundle] of [
    ["weave", "bundle"],
    ["weavePath", "bundlePath"],
    ["weaveRom", "bundleRom"],
    ["weaveFileName", "bundleFileName"],
    ["noWeaveRom", "noBundleRom"],
    ["weaveOutput", "bundleOutput"],
  ] as const) {
    const from = legacy ? weave : bundle;
    if (Object.hasOwn(output, from)) {
      const value = output[from];
      delete output[from];
      if (value !== undefined) output[legacy ? bundle : weave] = value;
    }
  }
  return output as T;
};

const adaptRuntime = <T extends WeaveRuntime | BundleRuntime>(
  runtime: WeaveRuntime | BundleRuntime,
  legacy = true,
): T => {
  const output: Record<string, unknown> = {};
  for (const operation of ["parse", "create"] as const) {
    const invoke = runtime[operation];
    if (invoke) {
      output[operation] = async (input: object) => {
        const result = renameFields<{ result: object }>(
          await (invoke as RuntimeMethod)(renameFields(input, !legacy)),
          legacy,
        );
        result.result = renameFields(result.result, legacy);
        return result;
      };
    }
  }
  return output as T;
};

const toBundleParseResult: (input: ParsedWeaveParseResult) => ParsedBundleParseResult = renameFields;
const toBundleCreateResult: (input: ParsedWeaveCreateResult) => ParsedBundleCreateResult = renameFields;
const createBundleRuntime: (weave: WeaveRuntime) => BundleRuntime = adaptRuntime;
const getWeaveRuntime = ({ weave, bundle }: Pick<WorkflowRuntime, "weave" | "bundle">): WorkflowRuntime["weave"] =>
  weave ?? (bundle ? adaptRuntime<WeaveRuntime>(bundle, false) : undefined);

export { createBundleRuntime, getWeaveRuntime, toBundleCreateResult, toBundleParseResult };
