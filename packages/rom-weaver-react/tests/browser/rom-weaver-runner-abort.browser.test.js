import { afterEach, beforeEach, expect, test, vi } from "vitest";

const workerClientState = vi.hoisted(() => ({
  disposeCalls: 0,
  initCalls: 0,
  resolveRuns: false,
  runCalls: 0,
  runOptions: [],
  terminateCalls: 0,
}));

const resetWorkerClientState = () => {
  workerClientState.disposeCalls = 0;
  workerClientState.initCalls = 0;
  workerClientState.resolveRuns = false;
  workerClientState.runCalls = 0;
  workerClientState.runOptions = [];
  workerClientState.terminateCalls = 0;
};

vi.mock("../../src/wasm/workers/browser-worker-client.ts", () => ({
  createBrowserWorkerClient: () => {
    const pendingRuns = new Set();
    return {
      dispose: async () => {
        workerClientState.disposeCalls += 1;
      },
      init: async () => {
        workerClientState.initCalls += 1;
        return {
          mode: "mock",
          threaded: true,
          wasmUrl: "/assets/rom-weaver-app.wasm",
        };
      },
      runJson: (_commandOrRequest, options) => {
        workerClientState.runCalls += 1;
        workerClientState.runOptions.push(options || {});
        if (workerClientState.resolveRuns) {
          return Promise.resolve({
            events: [],
            exitCode: 0,
            nonJsonLines: [],
            ok: true,
            stderr: "",
            traceEvents: [],
            traceNonJsonLines: [],
          });
        }
        return new Promise((_resolve, reject) => {
          pendingRuns.add(reject);
        });
      },
      terminate: () => {
        workerClientState.terminateCalls += 1;
        for (const reject of pendingRuns) {
          reject(Object.assign(new Error("worker terminated"), { code: "TERMINATED" }));
        }
        pendingRuns.clear();
      },
    };
  },
}));

const { resetRomWeaverRunner, runRomWeaverJson } = await import("../../src/workers/rom-weaver/rom-weaver-runner.ts");

beforeEach(async () => {
  await resetRomWeaverRunner();
  resetWorkerClientState();
});

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("aborting a runner run terminates the active worker and recycles the next run", async () => {
  if (!(typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true)) return;

  const controller = new AbortController();
  const pendingRun = runRomWeaverJson(
    {
      args: {
        source: "/work/input.bin",
      },
      type: "probe",
    },
    { signal: controller.signal },
  );

  await expect.poll(() => workerClientState.runCalls).toBe(1);
  expect(workerClientState.runOptions[0]?.signal).toBeUndefined();

  controller.abort();
  await expect(pendingRun).rejects.toMatchObject({
    code: "CANCELLED",
    name: "AbortError",
  });
  await expect.poll(() => workerClientState.terminateCalls).toBe(1);

  workerClientState.resolveRuns = true;
  const nextRun = await runRomWeaverJson({
    args: {
      source: "/work/input.bin",
    },
    type: "probe",
  });

  expect(nextRun).toMatchObject({
    exitCode: 0,
    ok: true,
  });
  expect(workerClientState.initCalls).toBe(2);
});
