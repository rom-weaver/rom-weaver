import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

type InputPreparationRuntime = Pick<WorkflowRuntime, "compression" | "ingest" | "name" | "workerIo">;
const DEFAULT_INPUT_PREPARATION_RUNTIME: Pick<WorkflowRuntime, "name"> = {
  name: "browser",
};

let defaultBrowserRuntimePromise: Promise<WorkflowRuntime> | null = null;

type BrowserRuntimeModule = {
  createBrowserRuntime: () => WorkflowRuntime;
};

const importBrowserRuntimeModule = () =>
  import("../../platform/browser/workflow-runtime.ts") as Promise<BrowserRuntimeModule>;

const resolveBrowserInputPreparationRuntime = async (): Promise<InputPreparationRuntime> => {
  if (!defaultBrowserRuntimePromise) {
    defaultBrowserRuntimePromise = importBrowserRuntimeModule().then(({ createBrowserRuntime }) =>
      createBrowserRuntime(),
    );
  }
  return defaultBrowserRuntimePromise;
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
