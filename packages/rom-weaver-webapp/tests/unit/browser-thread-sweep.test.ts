import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RomWeaverCommand, RomWeaverRunJsonEvent } from "../../src/wasm/rom-weaver-types.d.ts";

type RunJsonOptions = { onEvent?: (event: RomWeaverRunJsonEvent) => void };
type RunJsonResult = {
  events: RomWeaverRunJsonEvent[];
  exitCode: number;
  ok: boolean;
};

const guest = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  initCalls: [] as Record<string, unknown>[],
  removed: [] as string[],
  runs: [] as RomWeaverCommand[],
  terminations: 0,
  workerCreations: 0,
}));

const responses = vi.hoisted(() => ({
  compress: null as ((command: RomWeaverCommand) => RunJsonResult) | null,
  ingest: null as ((command: RomWeaverCommand) => RunJsonResult) | null,
}));

vi.mock("../../src/wasm/browser-matrix-guest-io.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/wasm/browser-matrix-guest-io.ts")>();
  return {
    ...actual,
    readGuestFile: vi.fn(async (_root: unknown, path: string) => guest.files.get(path) ?? new Uint8Array(0)),
    removeFixtureDirectory: vi.fn(async (_root: unknown, name: string) => {
      guest.removed.push(name);
    }),
    waitForGuestFile: vi.fn(async () => undefined),
    writeGuestFile: vi.fn(async (_root: unknown, path: string, bytes: Uint8Array) => {
      guest.files.set(path, bytes);
    }),
  };
});

vi.mock("../../src/wasm/workers/browser-worker-client.ts", () => ({
  createBrowserWorkerClient: vi.fn(() => {
    guest.workerCreations += 1;
    return {
      init: vi.fn(async (options: Record<string, unknown>) => {
        guest.initCalls.push(options);
      }),
      runJson: vi.fn(async (command: RomWeaverCommand, options: RunJsonOptions = {}) => {
        guest.runs.push(command);
        const respond = command.type === "compress" ? responses.compress : responses.ingest;
        const result = respond?.(command) ?? { events: [], exitCode: 1, ok: false };
        for (const event of result.events) options.onEvent?.(event);
        return result;
      }),
      terminate: vi.fn(() => {
        guest.terminations += 1;
      }),
    };
  }),
}));

const { runBrowserThreadSweep } = await import("../../src/wasm/browser-thread-sweep.ts");

type SweepEvent = Partial<RomWeaverRunJsonEvent> & { command: string; stage?: string; status: string };

function terminal(command: string, threads: number, overrides: Partial<SweepEvent> = {}): RomWeaverRunJsonEvent {
  return {
    command,
    effective_threads: threads,
    requested_threads: threads,
    stage: command,
    status: "succeeded",
    ...overrides,
  } as unknown as RomWeaverRunJsonEvent;
}

function readThreads(command: RomWeaverCommand): number {
  return Number((command.args as { threads?: number }).threads ?? 0);
}

type SweepSummary = Awaited<ReturnType<typeof runBrowserThreadSweep>>;

/** Every cell emits a "running" step followed by its outcome; only the outcomes matter here. */
const settledSteps = (summary: SweepSummary) => summary.steps.filter((step) => step.status !== "running");

const firstFailureError = (summary: SweepSummary) =>
  summary.steps.find((step) => step.status === "failed")?.error ?? "";

function compressOk(command: RomWeaverCommand): RunJsonResult {
  const threads = readThreads(command);
  return {
    events: [
      terminal("compress", threads, { stage: "create", status: "running" }),
      terminal("compress", threads, { effective_threads: 1, stage: "summary" }),
    ],
    exitCode: 0,
    ok: true,
  };
}

function ingestOkWith(assetPaths: string[]) {
  return (command: RomWeaverCommand): RunJsonResult => {
    const threads = readThreads(command);
    return {
      events: [
        terminal("ingest", threads, { effective_threads: threads, stage: "extract", status: "running" }),
        terminal("ingest", threads, {
          details: { ingest: { assets: assetPaths.map((path) => ({ path })) } },
          effective_threads: 1,
          stage: "ingest",
        }),
      ],
      exitCode: 0,
      ok: true,
    };
  };
}

/** The sweep verifies the round trip byte-for-byte, so ingest must "emit" the source bytes. */
function echoSourceEntries(prefix: string) {
  return (command: RomWeaverCommand): RunJsonResult => {
    const sources = [...guest.files.keys()].filter((path) => path.includes(prefix));
    const outputDir = String((command.args as { output?: string }).output ?? "/work/out");
    const emitted = sources.map((source) => {
      const target = `${outputDir}/${source.slice(source.lastIndexOf("/") + 1)}`;
      guest.files.set(target, guest.files.get(source) ?? new Uint8Array(0));
      return target;
    });
    return ingestOkWith(emitted)(command);
  };
}

beforeEach(() => {
  guest.files.clear();
  guest.initCalls.length = 0;
  guest.removed.length = 0;
  guest.runs.length = 0;
  guest.terminations = 0;
  guest.workerCreations = 0;
  responses.compress = compressOk;
  responses.ingest = echoSourceEntries("src-");

  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => ({}),
      }),
    },
  });
});

describe("runBrowserThreadSweep", () => {
  it("sweeps every requested thread count for one format and reports the round trip", async () => {
    const steps: { name: string; status: string }[] = [];
    const summary = await runBrowserThreadSweep({
      formats: ["chd"],
      onStep: (step) => steps.push({ name: step.name, status: step.status }),
      prefix: "sweep-test-",
      threadCounts: [1, 4],
      wasmUrl: "/rom-weaver.wasm",
    });

    expect(summary.passedSteps).toBe(2);
    expect(summary.failedSteps).toBe(0);
    expect(settledSteps(summary).map((step) => step.name)).toEqual(["chd/4m/threads-1", "chd/4m/threads-4"]);
    expect(steps.filter((step) => step.status === "running")).toHaveLength(2);
    expect(summary.observations.map((observation) => `${observation.command}:${observation.threads}`)).toEqual([
      "compress:1",
      "ingest:1",
      "compress:4",
      "ingest:4",
    ]);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records the per-stage thread breakdown rather than the terminal number", async () => {
    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [4] });

    const compress = summary.observations[0];
    expect(compress?.stageThreads).toBe("create:4 summary:1");
    expect(compress?.effectiveThreads).toBe(4);
    expect(compress?.terminalEffectiveThreads).toBe(1);
    expect(compress?.requestedThreads).toBe(4);

    const ingest = summary.observations[1];
    expect(ingest?.stageThreads).toBe("extract:4 ingest:1");
    expect(ingest?.entryCount).toBe(1);
    expect(ingest?.payloadBytes).toBe(4 * 1024 * 1024);
  });

  it("gives every cell a fresh worker and terminates it", async () => {
    await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [1, 2] });

    expect(guest.workerCreations).toBe(2);
    expect(guest.terminations).toBe(2);
    expect(guest.initCalls[0]).toMatchObject({
      runtimeMounts: ["/work"],
      wasmUrl: expect.stringContaining("rom-weaver"),
      workGuestPath: "/work",
    });
  });

  it("passes the requested thread count and no codec to both commands", async () => {
    await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [7] });

    const [compress, ingest] = guest.runs;
    expect(compress).toMatchObject({ args: { format: "chd", threads: 7 }, type: "compress" });
    expect(compress?.args as Record<string, unknown>).not.toHaveProperty("codec");
    expect(ingest).toMatchObject({ args: { threads: 7 }, type: "ingest" });
  });

  it("writes a GameCube header for rvz fixtures and plain filler otherwise", async () => {
    await runBrowserThreadSweep({ formats: ["rvz"], threadCounts: [1] });
    const rvzSource = [...guest.files.entries()].find(([path]) => path.includes("src-rvz"));
    expect(rvzSource?.[0]).toContain("disc-0.iso");
    const rvzBytes = rvzSource?.[1];
    expect(rvzBytes?.subarray(0x1c, 0x20)).toEqual(new Uint8Array([0xc2, 0x33, 0x9f, 0x3d]));
    expect(rvzBytes?.byteLength).toBe(0x440 + 4 * 1024 * 1024);

    guest.files.clear();
    await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [1] });
    const chdSource = [...guest.files.entries()].find(([path]) => path.includes("src-chd"));
    expect(chdSource?.[0]).toContain("entry-00.bin");
    expect(chdSource?.[1]?.byteLength).toBe(4 * 1024 * 1024);
  });

  it("sweeps both payload sizes of an archive format", async () => {
    const summary = await runBrowserThreadSweep({ formats: ["zip"], threadCounts: [1] });

    expect(settledSteps(summary).map((step) => step.name)).toEqual(["zip/256k/threads-1", "zip/512k/threads-1"]);
    expect(summary.observations.every((observation) => observation.entryCount === 16)).toBe(true);
  });

  it("filters out unknown format names", async () => {
    const summary = await runBrowserThreadSweep({ formats: ["nope"], threadCounts: [1] });

    expect(summary.steps).toEqual([]);
    expect(summary.observations).toEqual([]);
    expect(guest.workerCreations).toBe(0);
  });

  it("records a failing cell and keeps sweeping the remaining thread counts", async () => {
    responses.compress = (command) => {
      if (readThreads(command) === 2) return { events: [], exitCode: 1, ok: false };
      return compressOk(command);
    };

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [1, 2, 3] });

    expect(summary.failedSteps).toBe(1);
    expect(summary.passedSteps).toBe(2);
    const failed = summary.steps.find((step) => step.status === "failed");
    expect(failed?.name).toBe("chd/4m/threads-2");
    expect(failed?.error).toContain("runJson result should include at least one event");
    expect(guest.terminations).toBe(3);
  });

  it("fails the cell when requested_threads does not echo the request", async () => {
    responses.compress = (command) => ({
      events: [terminal("compress", readThreads(command), { requested_threads: 1 })],
      exitCode: 0,
      ok: true,
    });

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [4] });

    expect(firstFailureError(summary)).toContain("requested_threads should echo the request, got 1");
  });

  it("fails the cell when effective_threads exceeds the request or is missing", async () => {
    responses.compress = (command) => ({
      events: [terminal("compress", readThreads(command), { effective_threads: 99 })],
      exitCode: 0,
      ok: true,
    });
    const over = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [4] });
    expect(firstFailureError(over)).toContain("effective_threads 99 should not exceed the 4 requested");

    responses.compress = (command) => ({
      events: [terminal("compress", readThreads(command), { effective_threads: undefined })],
      exitCode: 0,
      ok: true,
    });
    const missing = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [4] });
    expect(firstFailureError(missing)).toContain("effective_threads should be at least 1, got null");
  });

  it("fails the cell when a thread fallback carries no reason", async () => {
    responses.compress = (command) => ({
      events: [terminal("compress", readThreads(command), { thread_fallback: true })],
      exitCode: 0,
      ok: true,
    });

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [2] });
    expect(firstFailureError(summary)).toContain("thread_fallback was reported without a thread_fallback_reason");
  });

  it("records the fallback reason when one is supplied", async () => {
    responses.compress = (command) => ({
      events: [
        terminal("compress", readThreads(command), {
          thread_fallback: true,
          thread_fallback_reason: "no SharedArrayBuffer",
          thread_mode: "single",
          used_parallelism: false,
        }),
      ],
      exitCode: 0,
      ok: true,
    });

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [2] });
    expect(summary.observations[0]).toMatchObject({
      threadFallback: true,
      threadFallbackReason: "no SharedArrayBuffer",
      threadMode: "single",
      usedParallelism: false,
    });
  });

  it("fails the cell when ingest reports the wrong asset count", async () => {
    responses.ingest = ingestOkWith([]);

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [1] });
    expect(firstFailureError(summary)).toBe("chd/4m/threads-1: ingest reported 0 assets, expected 1");
  });

  it("fails the cell when a round-tripped asset does not match its source", async () => {
    responses.ingest = (command) => {
      const outputDir = String((command.args as { output?: string }).output ?? "/work/out");
      const target = `${outputDir}/entry-00.bin`;
      guest.files.set(target, new Uint8Array(8));
      return ingestOkWith([target])(command);
    };

    const summary = await runBrowserThreadSweep({ formats: ["chd"], threadCounts: [1] });
    expect(firstFailureError(summary)).toContain("changed in the round trip");
  });

  it("fails the cell when an emitted archive entry has no matching source", async () => {
    responses.ingest = (command) => {
      const outputDir = String((command.args as { output?: string }).output ?? "/work/out");
      const emitted = Array.from({ length: 16 }, (_value, index) => `${outputDir}/surprise-${index}.bin`);
      for (const path of emitted) guest.files.set(path, new Uint8Array(0));
      return ingestOkWith(emitted)(command);
    };

    const summary = await runBrowserThreadSweep({ formats: ["zip"], threadCounts: [1] });
    expect(firstFailureError(summary)).toContain("ingest emitted an unexpected asset surprise-0.bin");
  });

  it("removes the per-size fixtures and the sweep root even when a cell fails", async () => {
    responses.compress = () => ({ events: [], exitCode: 1, ok: false });

    const summary = await runBrowserThreadSweep({ formats: ["chd"], prefix: "cleanup-", threadCounts: [1] });

    expect(summary.failedSteps).toBe(1);
    expect(guest.removed).toHaveLength(2);
    expect(guest.removed[0]).toMatch(/^cleanup-\d+-[0-9a-f]+\/src-chd-4m$/);
    expect(guest.removed[1]).toMatch(/^cleanup-\d+-[0-9a-f]+$/);
  });
});
