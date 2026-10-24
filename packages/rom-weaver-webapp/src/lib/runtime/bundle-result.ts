import { parseWeaveCreateResult, parseWeaveParseResult } from "./weave-result.ts";
import { toBundleCreateResult, toBundleParseResult } from "./bundle-runtime.ts";

const parseBundleParseResult = (details: unknown) => {
  const parsed = parseWeaveParseResult(details);
  return parsed ? toBundleParseResult(parsed) : undefined;
};
const parseBundleCreateResult = (details: unknown) => {
  const parsed = parseWeaveCreateResult(details);
  return parsed ? toBundleCreateResult(parsed) : undefined;
};
export { parseBundleCreateResult, parseBundleParseResult };
