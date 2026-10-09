import type { ParsedBundleParseResult } from "../../types/bundle.ts";
import { buildWeaveApplySessionPlan } from "../weave/weave-session-model.ts";

const buildBundleApplySessionPlan = ({ bundle, ...rest }: ParsedBundleParseResult, bundleUrl: string) =>
  buildWeaveApplySessionPlan({ ...rest, weave: bundle }, bundleUrl);

export type {
  WeaveApplySession as BundleApplySession,
  WeaveApplySessionEntry as BundleApplySessionEntry,
  WeaveRomExpectation as BundleRomExpectation,
} from "../weave/weave-session-model.ts";
export {
  weaveChainEndpointChecks as bundleChainEndpointChecks,
  weaveRomExpectation as bundleRomExpectation,
  weaveSessionDisplayName as bundleSessionDisplayName,
} from "../weave/weave-session-model.ts";
export { buildBundleApplySessionPlan };
