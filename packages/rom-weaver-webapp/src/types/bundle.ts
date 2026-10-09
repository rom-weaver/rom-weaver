import type { BundleSourceKind } from "../wasm/generated/rom-weaver-rust-types.d.ts";
import type { ParsedWeave, ParsedWeaveCreateResult, ParsedWeaveParseResult } from "./weave.ts";

export type {
  WeaveHeaderMode as BundleHeaderMode,
  ParsedWeave as ParsedBundle,
  ParsedWeaveChecks as ParsedBundleChecks,
  ParsedWeaveOutput as ParsedBundleOutput,
  ParsedWeavePatchEntry as ParsedBundlePatchEntry,
  ParsedWeavePatchInput as ParsedBundlePatchInput,
  ParsedWeavePatchSource as ParsedBundlePatchSource,
  ParsedWeaveRom as ParsedBundleRom,
  ParsedWeaveSourceRef as ParsedBundleSourceRef,
} from "./weave.ts";

type ParsedBundleParseResult = Omit<ParsedWeaveParseResult, "weave"> & { bundle: ParsedWeave };
type ParsedBundleCreateResult = Omit<ParsedWeaveCreateResult, "weave" | "weavePath"> & {
  bundle: ParsedWeave;
  bundlePath: string;
};

export type { BundleSourceKind, ParsedBundleParseResult, ParsedBundleCreateResult };
