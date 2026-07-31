import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

type InputPreparationRuntime = Pick<WorkflowRuntime, "compression" | "ingest" | "name" | "workerIo">;
const DEFAULT_INPUT_PREPARATION_RUNTIME: Pick<WorkflowRuntime, "name"> = {
  name: "browser",
};

let defaultBrowserRuntime: WorkflowRuntime | null = null;

const resolveBrowserInputPreparationRuntime = async (): Promise<InputPreparationRuntime> => {
  if (!defaultBrowserRuntime) {
    const { createBrowserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
    defaultBrowserRuntime = createBrowserRuntime();
  }
  return defaultBrowserRuntime;
};

const resolveDefaultInputPreparationRuntime = async (): Promise<InputPreparationRuntime> =>
  resolveBrowserInputPreparationRuntime();

const resolveNamedInputPreparationRuntime = async (runtimeName: WorkflowRuntime["name"]) => {
  if (runtimeName === "browser") return resolveBrowserInputPreparationRuntime();
  return resolveDefaultInputPreparationRuntime();
};

const resolveInputPreparationRuntime = async (
  runtime: InputPreparationRuntime | Pick<WorkflowRuntime, "name"> = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<InputPreparationRuntime> => {
  if ("workerIo" in runtime && runtime.workerIo) return runtime;
  return resolveNamedInputPreparationRuntime(runtime.name);
};

export type { InputPreparationRuntime };
export { DEFAULT_INPUT_PREPARATION_RUNTIME, resolveInputPreparationRuntime };
