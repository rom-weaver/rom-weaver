import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  browser: true,
  clients: [] as Array<Record<string, unknown>>,
  disposeAll: vi.fn(async () => undefined),
  forced: vi.fn((request: unknown, threads: number) => ({ ...(request as object), forcedThreads: threads })),
  initOptions: [] as unknown[],
  markStale: vi.fn(),
  run: vi.fn(),
  supportsThreads: vi.fn((command: { type?: string }) => command.type !== "probe"),
  virtualFiles: [] as Array<{ path: string; source?: unknown; useProxyHandle?: boolean }>,
}));

vi.mock("../../src/lib/errors.ts", () => ({
  OUT_OF_MEMORY_MESSAGE_REGEX: /out of memory|cannot enlarge memory|ENOMEM/i,
}));
vi.mock("../../src/lib/logging.ts", () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../src/lib/perf/op-perf-marks.ts", () => ({ markWasmFinished: vi.fn() }));
vi.mock("../../src/lib/runtime/compression-thread-budget.ts", () => ({ toThreadBudget: (value: unknown) => value }));
vi.mock("../../src/lib/runtime/op-memory-estimate.ts", () => ({
  estimateOpWorkingSetBytes: vi.fn(() => 100),
  estimateScheduledThreads: vi.fn((_command: unknown, _bytes: number, requested: number) => Math.min(2, requested)),
  isMobileRuntime: vi.fn(() => false),
  resolveAppleMobileSharedMemoryMaximumPages: vi.fn(() => undefined),
  resolveMemoryCeilingBytes: vi.fn(() => 1024 * 1024),
}));
vi.mock("../../src/lib/runtime/perf-latency.ts", () => ({ perfNow: vi.fn(() => 10), recordCommandLatency: vi.fn() }));
vi.mock("../../src/lib/runtime/run-options.ts", () => ({ toRomWeaverOptions: (options: object) => options }));
vi.mock("../../src/platform/shared/compression-options.ts", () => ({ getDefaultBrowserThreadCount: vi.fn(() => 4) }));
vi.mock("../../src/wasm/index.ts", () => ({
  collectRomWeaverRunInputPaths: vi.fn(
    (_request: { args?: { input?: unknown } }, options?: { knownInputPaths?: string[] }) =>
      options?.knownInputPaths ??
      (Array.isArray(_request.args?.input) ? _request.args.input : [_request.args?.input].filter(Boolean)),
  ),
  createRomWeaverCommand: vi.fn((type: string, args: unknown) => ({ type, args })),
  readRomWeaverRequestedThreadCount: vi.fn(() => 8),
  readRomWeaverRunInputCommand: vi.fn((request: unknown) => request),
  romWeaverCommandSupportsThreads: state.supportsThreads,
  withRomWeaverForcedThreads: state.forced,
}));
vi.mock("../../src/wasm/workers/browser-worker-client.ts", () => ({
  createBrowserWorkerClient: vi.fn(() => {
    const client = {
      dispose: vi.fn(async () => undefined),
      init: vi.fn(async (options: unknown) => {
        state.initOptions.push(options);
        return { mode: "browser-opfs", threaded: true, wasmUrl: "/worker.wasm" };
      }),
      runJson: state.run,
      terminate: vi.fn(),
    };
    state.clients.push(client);
    return client;
  }),
}));
vi.mock("../../src/wasm/workers/worker-trace-format.ts", () => ({
  formatCommandForTrace: (command: unknown) => String((command as { type?: string })?.type ?? "unknown"),
}));
vi.mock("../../src/workers/protocol/browser-opfs-source-ref.ts", () => ({ getStagedInputMs: vi.fn(() => undefined) }));
vi.mock("../../src/workers/protocol/browser-virtual-files.ts", () => ({
  getActiveBrowserVirtualFiles: () => state.virtualFiles,
}));
vi.mock("../../src/workers/shared/runtime-env.ts", () => ({ isBrowserRuntime: () => state.browser }));
vi.mock("../../src/workers/rom-weaver/rom-weaver-run-events.ts", () => ({
  getRomWeaverRunEventDetails: (event: unknown) => (event as { details?: unknown })?.details,
  getRomWeaverRunEventElapsedMs: (event: unknown) => (event as { elapsed_ms?: number })?.elapsed_ms,
  isRomWeaverTerminalRunEvent: (event: unknown) => (event as { status?: string })?.status === "succeeded",
}));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", async () =>
  vi.importActual<typeof import("../../src/workers/rom-weaver/runner-control.ts")>(
    "../../src/workers/rom-weaver/runner-control.ts",
  ),
);

const { getRomWeaverRunnerMetadata, resetRomWeaverRunner, runRomWeaverJson, warmupRomWeaverRunner } =
  await import("../../src/workers/rom-weaver/rom-weaver-runner.ts");

const command = (type: string, input: unknown = "/work/input.bin") => ({ type, args: { input } }) as never;
const success = (details: unknown = {}) => ({
  events: [{ details, elapsed_ms: 42, status: "succeeded" }],
  exitCode: 0,
  ok: true,
});

beforeEach(async () => {
  await resetRomWeaverRunner({ terminate: true });
  state.browser = true;
  state.clients.length = 0;
  state.initOptions.length = 0;
  state.virtualFiles = [];
  state.run.mockReset();
  state.run.mockResolvedValue(success());
  state.forced.mockClear();
  state.markStale.mockClear();
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
      clone() {
        return this;
      },
      ok: true,
      status: 200,
      statusText: "OK",
    })),
  );
  vi.spyOn(WebAssembly, "compileStreaming").mockRejectedValue(new Error("wrong MIME"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser runner lifecycle", () => {
  it("warms one client, reuses its metadata, and forwards the resolved init options", async () => {
    const ready = await warmupRomWeaverRunner("auto");
    expect(ready).toMatchObject({ mode: "browser-opfs", threaded: true });
    expect(await getRomWeaverRunnerMetadata()).toEqual(ready);
    expect(state.clients).toHaveLength(1);
    expect(state.initOptions[0]).toMatchObject({
      defaultThreads: 4,
      opfsProxyWorkerUrl: expect.any(String),
      runtimeMounts: ["/work"],
      threadWorkerUrl: expect.any(String),
      wasmUrl: expect.any(String),
      workGuestPath: "/work",
    });
  });

  it("rejects warmup and metadata outside a browser runtime", async () => {
    state.browser = false;
    await expect(warmupRomWeaverRunner()).rejects.toThrow("only available in browser runtimes");
    await expect(getRomWeaverRunnerMetadata()).rejects.toThrow("only available in browser runtimes");
  });

  it("requires shared memory and cross-origin isolation before creating a worker", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    await resetRomWeaverRunner({ terminate: true });
    await expect(warmupRomWeaverRunner()).rejects.toThrow(/SharedArrayBuffer and cross-origin isolation/);
    expect(state.clients).toHaveLength(1);
    expect(state.clients[0]?.init).not.toHaveBeenCalled();
    expect(state.clients[0]?.terminate).toHaveBeenCalled();
  });

  it("rebuilds the warm pool when the thread seed changes", async () => {
    await warmupRomWeaverRunner(2);
    await warmupRomWeaverRunner(8);
    expect(state.clients).toHaveLength(2);
  });

  it("resets gracefully and can hard-terminate the pool", async () => {
    await warmupRomWeaverRunner();
    await resetRomWeaverRunner();
    expect(state.clients[0]?.terminate).toHaveBeenCalled();
    await warmupRomWeaverRunner();
    await resetRomWeaverRunner({ terminate: true });
    expect(state.clients[1]?.terminate).toHaveBeenCalled();
  });
});

describe("runRomWeaverJson", () => {
  it("scopes active virtual files, adds defaults, and forces an allotted thread count", async () => {
    state.virtualFiles = [
      { path: "/work/input.bin", source: new Uint8Array([1, 2, 3]) },
      { path: "/work/other.bin", source: new Uint8Array([4]) },
    ];
    const traceLines: string[] = [];
    const result = await runRomWeaverJson(command("compress", "/work/input.bin"), {
      onTraceNonJsonLine: (line) => traceLines.push(line),
      virtualFiles: [{ path: "/work/config.json" }],
    });

    expect(result).toEqual(success());
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ forcedThreads: 2 }),
      expect.objectContaining({
        interactiveSelectionEnabled: true,
        invalidateMountCacheAfterRun: true,
        virtualFiles: [state.virtualFiles[0], { path: "/work/config.json" }],
      }),
    );
    expect(traceLines.some((line) => line.includes("activeVirtualFiles"))).toBe(true);
  });

  it("keeps all active files for cue-based disc compression", async () => {
    state.virtualFiles = [
      { path: "/work/disc.cue", source: new Uint8Array([1]) },
      { path: "/work/disc.bin", source: new Uint8Array([2]) },
    ];
    await runRomWeaverJson(command("compress", "/work/disc.cue"));
    expect(state.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ virtualFiles: state.virtualFiles }),
    );
  });

  it("rejects before dispatch when already aborted and terminates an active run on abort", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runRomWeaverJson(command("probe"), { signal: preAborted.signal })).rejects.toMatchObject({
      code: "CANCELLED",
      name: "AbortError",
    });

    let rejectRun!: (error: unknown) => void;
    state.run.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      }),
    );
    const controller = new AbortController();
    const pending = runRomWeaverJson(command("probe"), { signal: controller.signal });
    await vi.waitFor(() => expect(state.run).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", name: "AbortError" });
    expect(state.clients.at(-1)?.terminate).toHaveBeenCalled();
    rejectRun(new Error("late result"));
  });

  it("terminates a failed runner on an out-of-memory result and propagates other errors", async () => {
    state.run.mockRejectedValueOnce(new Error("Out of memory"));
    await expect(runRomWeaverJson(command("compress"))).rejects.toThrow("Out of memory");
    expect(state.clients.at(-1)?.terminate).toHaveBeenCalled();

    state.run.mockRejectedValueOnce(new Error("network failed"));
    await expect(runRomWeaverJson(command("probe"))).rejects.toThrow("network failed");
  });
});

describe("runner diagnostics and batch plans", () => {
  it("plans extraction waves from the terminal details", async () => {
    state.run.mockResolvedValueOnce(
      success({ extract_batch_plan: { waves: [{ jobs: [0, "2", -1, "bad"], threads_per_job: 2.9 }, null] } }),
    );
    const plan = await runRomWeaverJson(command("plan-extract-batch"));
    expect(plan).toMatchObject({ ok: true });

    state.run.mockResolvedValueOnce(success({}));
    await expect(runRomWeaverJson(command("plan-extract-batch"))).resolves.toEqual(success({}));
  });

  it("falls back to a serial extraction when the planner returns a malformed plan", async () => {
    state.run
      .mockResolvedValueOnce(success({ extract_batch_plan: { waves: [null] } }))
      .mockResolvedValueOnce(success({ extracted: true }));
    await expect(runRomWeaverJson(command("extract"))).resolves.toEqual(success({ extracted: true }));
  });
});
