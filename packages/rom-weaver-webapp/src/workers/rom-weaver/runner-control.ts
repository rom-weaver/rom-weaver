import { createLogger } from "../../lib/logging.ts";

type InputSelectionHandler = (request: string) => number[] | Promise<number[]>;

type RunnerLifecycleControl = {
  disposeAll: (options: { terminate?: boolean }) => Promise<void>;
  markAllStale: () => void;
};

type RunnerModule = typeof import("./rom-weaver-runner.ts");

const logger = createLogger("rom-weaver-runner");

let inputSelectionHandler: InputSelectionHandler | undefined;
let inputSelectionChain: Promise<unknown> = Promise.resolve();
let runnerLifecycleControl: RunnerLifecycleControl | null = null;
let runnerModulePromise: Promise<RunnerModule> | undefined;

const loadRomWeaverRunner = () => (runnerModulePromise ??= import("./rom-weaver-runner.ts"));

const setInputSelectionHandler = (handler?: InputSelectionHandler) => {
  logger.trace(handler ? "input selection handler registered" : "input selection handler cleared");
  inputSelectionHandler = handler;
};

const summarizeInputSelectionRequest = (request: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request);
    return {
      candidateCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
      heading: typeof parsed?.heading === "string" ? parsed.heading : "",
      mode: typeof parsed?.mode === "string" ? parsed.mode : "single",
    };
  } catch {
    return { requestBytes: request.length, unparsable: true };
  }
};

const resolveInputSelection: InputSelectionHandler = (request) => {
  const run = inputSelectionChain
    .catch(() => undefined)
    .then(() => {
      if (!inputSelectionHandler) {
        logger.trace("input selection requested but no handler registered - cancelling", {
          requestBytes: typeof request === "string" ? request.length : 0,
        });
        return [];
      }
      logger.trace("forwarding input selection request to UI handler", summarizeInputSelectionRequest(request));
      return inputSelectionHandler(request);
    });
  inputSelectionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const registerRunnerLifecycle = (control: RunnerLifecycleControl) => {
  runnerLifecycleControl = control;
};

const resetRomWeaverRunner = async (options: { terminate?: boolean } = {}) => {
  await runnerLifecycleControl?.disposeAll(options);
};

const markRomWeaverRunnerStale = () => {
  runnerLifecycleControl?.markAllStale();
};

const noteRomWeaverIoBatch = async (jobSizes: number[]) => {
  const runner = await loadRomWeaverRunner();
  runner.noteRomWeaverIoBatch(jobSizes);
};

const recycleWarmRomWeaverRunner = async (threads?: RuntimeValue) => {
  const runner = await loadRomWeaverRunner();
  await runner.recycleWarmRomWeaverRunner(threads);
};

const warmupRomWeaverRunner = async (threads?: RuntimeValue) => {
  const runner = await loadRomWeaverRunner();
  return runner.warmupRomWeaverRunner(threads);
};

export {
  markRomWeaverRunnerStale,
  noteRomWeaverIoBatch,
  recycleWarmRomWeaverRunner,
  registerRunnerLifecycle,
  resetRomWeaverRunner,
  resolveInputSelection,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
};
export type { InputSelectionHandler };
