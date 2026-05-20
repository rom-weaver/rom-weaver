export { browserRuntime, createBrowserRuntime } from "../../platform/browser/workflow-runtime.ts";
export type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

const getPublicOutputSize = (output: { size?: number }) => output.size || 0;

export { getPublicOutputSize };
