import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileSystemDirectoryHandleLike } from "../../src/wasm/browser-opfs-runtime-types.ts";

type FdBuildArgs = {
  cwdMountPath: string;
  knownInputPaths: string[];
  mountHandles: Record<string, unknown>;
  runtimeMounts: string[];
  stderrLineHandler?: (line: string) => void;
  stdin: string;
  stdoutLineHandler?: (line: string) => void;
  syncAccessMode?: string;
  virtualFiles: { path: string; useProxyHandle?: boolean }[];
  virtualOnlyMounts: boolean;
  writableRoots: string[];
};

const harness = vi.hoisted(() => {
  const state = {
    buildFdsCalls: [] as FdBuildArgs[],
    buildFdsError: null as Error | null,
    guestStderr: "",
    guestStdout: "",
    poolDisposed: 0,
    proxyRegistered: [] as string[],
    proxyStopped: 0,
    proxyUnregistered: [] as string[],
    runScratchCleanups: [] as { runId: string; workGuestPath: string }[],
    runScratchError: null as Error | null,
    spawnerArgs: [] as { envList: string[] }[],
    spawnerDrains: 0,
    spawnerReadyError: null as Error | null,
    spawnerWaitError: null as Error | null,
    startError: null as Error | null,
    startExitCode: 0,
    threadFailure: null as Error | null,
  };
  return state;
});

vi.mock("../../src/wasm/browser-opfs-mounts.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/wasm/browser-opfs-mounts.ts")>();
  return {
    ...actual,
    buildBrowserOpfsWasiFds: vi.fn(async (args: FdBuildArgs) => {
      harness.buildFdsCalls.push(args);
      if (harness.buildFdsError) throw harness.buildFdsError;
      const encoder = new TextEncoder();
      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      return {
        fds: [],
        mounts: [],
        stderrChunks,
        stderrCollector: {
          flush() {
            if (!harness.guestStderr) return;
            stderrChunks.push(encoder.encode(harness.guestStderr));
            for (const line of harness.guestStderr.split("\n")) {
              if (line) args.stderrLineHandler?.(line);
            }
          },
        },
        stdoutChunks,
        stdoutCollector: {
          flush() {
            if (!harness.guestStdout) return;
            stdoutChunks.push(encoder.encode(harness.guestStdout));
            for (const line of harness.guestStdout.split("\n")) {
              if (line) args.stdoutLineHandler?.(line);
            }
          },
        },
      };
    }),
  };
});

vi.mock("../../src/wasm/browser-opfs-proxy-runtime.ts", () => ({
  startOpfsProxyRuntime: vi.fn(async () => ({
    client: { handleStats: () => ({ live: 1, opened: 4, peak: 2 }) },
    registerBlobSource: (path: string) => harness.proxyRegistered.push(path),
    setTrace: vi.fn(),
    stop: async () => {
      harness.proxyStopped += 1;
    },
    transfer: { globalControl: null },
    unregisterBlobSource: (path: string) => harness.proxyUnregistered.push(path),
  })),
}));

vi.mock("../../src/wasm/browser-opfs-run-cleanup.ts", () => ({
  cleanupBrowserOpfsRunScratch: vi.fn(async (args: { runId: string; workGuestPath: string }) => {
    harness.runScratchCleanups.push({ runId: args.runId, workGuestPath: args.workGuestPath });
    if (harness.runScratchError) throw harness.runScratchError;
  }),
}));

vi.mock("../../src/wasm/browser-wasi-thread-pool.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/wasm/browser-wasi-thread-pool.ts")>();
  return {
    ...actual,
    createBrowserWasiThreadSpawner: vi.fn((args: { envList: string[] }) => {
      harness.spawnerArgs.push(args);
      return {
        get ready() {
          return harness.spawnerReadyError ? Promise.reject(harness.spawnerReadyError) : Promise.resolve();
        },
        spawn: vi.fn(() => 0),
        waitForWorkers: vi.fn(async () => {
          harness.spawnerDrains += 1;
          if (harness.spawnerWaitError) throw harness.spawnerWaitError;
        }),
      };
    }),
    createBrowserWasiThreadWorkerPool: vi.fn(() => ({
      dispose: async () => {
        harness.poolDisposed += 1;
      },
    })),
    throwWithThreadFailure: vi.fn(async (error: unknown) => {
      throw harness.threadFailure ?? error;
    }),
  };
});

const { createRomWeaverBrowserOpfs } = await import("../../src/wasm/browser-opfs-runner.ts");
const { buildBrowserOpfsWasiFds } = await import("../../src/wasm/browser-opfs-mounts.ts");
const { startOpfsProxyRuntime } = await import("../../src/wasm/browser-opfs-proxy-runtime.ts");

/** The smallest byte sequence WebAssembly.compile accepts: the magic number plus version. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const THREADED_IMPORTS: WebAssembly.ModuleImportDescriptor[] = [
  { kind: "memory", module: "env", name: "memory" },
  { kind: "function", module: "wasi", name: "thread-spawn" },
];

let wasmModule: WebAssembly.Module;
let removedProbeNames: string[];
let rootEntries: [string, { kind: string }][];

function makeRootHandle(): FileSystemDirectoryHandleLike & { resolve: (handle: unknown) => Promise<string[] | null> } {
  return {
    entries: async function* entries() {
      yield* rootEntries;
    },
    getDirectoryHandle: async () => ({}),
    getFileHandle: async () => ({
      createSyncAccessHandle: async () => ({
        close: () => undefined,
        flush: () => undefined,
        write: () => 2,
      }),
    }),
    kind: "directory",
    removeEntry: async (name: string) => {
      removedProbeNames.push(name);
    },
    resolve: async () => [],
  };
}

function resetHarness() {
  harness.buildFdsCalls.length = 0;
  harness.buildFdsError = null;
  harness.guestStderr = "";
  harness.guestStdout = "";
  harness.poolDisposed = 0;
  harness.proxyRegistered.length = 0;
  harness.proxyStopped = 0;
  harness.proxyUnregistered.length = 0;
  harness.runScratchCleanups.length = 0;
  harness.runScratchError = null;
  harness.spawnerArgs.length = 0;
  harness.spawnerDrains = 0;
  harness.spawnerReadyError = null;
  harness.spawnerWaitError = null;
  harness.startError = null;
  harness.startExitCode = 0;
  harness.threadFailure = null;
}

let instantiatedImports: WebAssembly.Imports | null = null;

beforeEach(async () => {
  resetHarness();
  vi.clearAllMocks();
  removedProbeNames = [];
  rootEntries = [];
  instantiatedImports = null;
  wasmModule = await WebAssembly.compile(EMPTY_WASM);

  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("FileSystemSyncAccessHandle", class {});
  vi.stubGlobal("navigator", { hardwareConcurrency: 4, storage: { getDirectory: async () => makeRootHandle() } });

  vi.spyOn(WebAssembly.Module, "imports").mockReturnValue([]);
  vi.spyOn(WebAssembly, "instantiate").mockImplementation((async (_module: unknown, imports: WebAssembly.Imports) => {
    instantiatedImports = imports;
    return {
      exports: {
        _start: () => {
          if (harness.startError) throw harness.startError;
          if (harness.startExitCode !== 0) throw new wasiShim.WASIProcExit(harness.startExitCode);
        },
        memory: new WebAssembly.Memory({ initial: 1 }),
      },
    };
  }) as unknown as typeof WebAssembly.instantiate);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const compressCommand = (args: Record<string, unknown> = {}) => ({
  args: { input: "/work/game.iso", ...args },
  type: "compress" as const,
});

const createRunner = (options: Record<string, unknown> = {}) =>
  createRomWeaverBrowserOpfs({ module: wasmModule, ...options });

describe("createRomWeaverBrowserOpfs runner shape", () => {
  it("exposes the normalized guest paths, mounts and threading flags", async () => {
    const runner = await createRunner();

    expect(runner.mode).toBe("browser-opfs");
    expect(runner.fs).toBeNull();
    expect(runner.workGuestPath).toBe("/work");
    expect(runner.opfsGuestPath).toBe("/work");
    expect(runner.runtimeMounts).toEqual(["/work"]);
    expect(runner.writableRoots).toEqual(["/work"]);
    expect(runner.threaded).toBe(false);
    expect(runner.wasmUrl).toBeNull();
    expect(startOpfsProxyRuntime).toHaveBeenCalledTimes(1);
  });

  it("honours the deprecated opfsGuestPath alias and extra runtime mounts", async () => {
    const runner = await createRunner({
      mountHandles: { "/cache": makeRootHandle() },
      opfsGuestPath: "/staging",
      runtimeMounts: ["/staging", "/cache"],
    });

    expect(runner.workGuestPath).toBe("/staging");
    expect(runner.runtimeMounts).toEqual(["/staging", "/cache"]);
  });

  it("removes stale writable probes and its own probe, leaving fresh probes alone", async () => {
    const stale = `.rw-probe-${Date.now() - 120_000}-stale`;
    rootEntries = [
      [stale, { kind: "file" }],
      [`.rw-probe-${Date.now()}-fresh`, { kind: "file" }],
      [".rw-probe-dir", { kind: "directory" }],
      ["rom.iso", { kind: "file" }],
    ];
    await createRunner();

    expect(removedProbeNames).toHaveLength(2);
    expect(removedProbeNames[0]).toBe(stale);
    expect(removedProbeNames[1]?.startsWith(".rw-probe-")).toBe(true);
    expect(removedProbeNames[1]).not.toBe(stale);
  });

  it("rejects a non-directory opfsHandle", async () => {
    await expect(createRunner({ opfsHandle: { kind: "file" } })).rejects.toThrow(
      "opfsHandle must be a FileSystemDirectoryHandle",
    );
  });

  it("refuses a threaded module without cross-origin isolation", async () => {
    vi.spyOn(WebAssembly.Module, "imports").mockReturnValue(THREADED_IMPORTS);
    await expect(createRunner()).rejects.toThrow(/threaded wasm requires SharedArrayBuffer/);
  });

  it("disposes the mount cache, thread pool and proxy runtime", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    vi.spyOn(WebAssembly.Module, "imports").mockReturnValue(THREADED_IMPORTS);
    const runner = await createRunner();
    expect(runner.threaded).toBe(true);

    await runner.dispose();
    expect(harness.poolDisposed).toBe(1);
    expect(harness.proxyStopped).toBe(1);
  });
});

describe("createRomWeaverBrowserOpfs run", () => {
  it("leaves the rayon globals unset on a non-threaded run", async () => {
    const runner = await createRunner();
    await runner.run(compressCommand());

    expect(harness.spawnerArgs[0]?.envList.some((entry) => entry.startsWith("RAYON_"))).toBe(false);
  });

  it("returns the guest exit code, decoded streams and the normalized request", async () => {
    harness.guestStdout = "hello\n";
    harness.guestStderr = "warn\n";
    const runner = await createRunner();

    const result = await runner.run(compressCommand());

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("warn\n");
    expect(result.command).toEqual({ args: { input: "/work/game.iso", threads: 4 }, type: "compress" });
    expect(harness.runScratchCleanups).toHaveLength(1);
    expect(harness.runScratchCleanups[0]?.workGuestPath).toBe("/work");
  });

  it("reports a non-zero guest exit as not ok", async () => {
    harness.startExitCode = 3;
    const runner = await createRunner();

    const result = await runner.run(compressCommand());
    expect(result.exitCode).toBe(3);
    expect(result.ok).toBe(false);
  });

  it("feeds the request to the guest on stdin as one JSON line", async () => {
    const runner = await createRunner();
    await runner.run({ args: { input: "/work/a.iso", size: 9_007_199_254_740_991n }, type: "probe" });

    const stdin = harness.buildFdsCalls[0]?.stdin ?? "";
    expect(stdin.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdin)).toEqual({
      command: { args: { input: "/work/a.iso", size: 9_007_199_254_740_991 }, type: "probe" },
      output: {},
    });
  });

  it("rejects a request bigint that cannot round-trip through JSON", async () => {
    const runner = await createRunner();
    await expect(
      runner.run({ args: { input: "/work/a.iso", size: 9_007_199_254_740_993n }, type: "probe" }),
    ).rejects.toThrow("rom-weaver run request bigint values must fit in a JSON-safe number");
  });

  it("captures the failure as a result instead of throwing when the guest traps", async () => {
    harness.startError = new Error("wasm trap");
    const traceLines: string[] = [];
    const runner = await createRunner();

    const result = await runner.run(compressCommand(), { onTraceNonJsonLine: (line) => traceLines.push(line) });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    expect(traceLines.some((line) => line.includes("wasi.start threw"))).toBe(true);
    expect(traceLines.some((line) => line.includes("[browser-opfs] run failed"))).toBe(true);
  });

  it("replaces an opaque trap with the worker-side thread failure", async () => {
    harness.startError = new Error("unreachable");
    harness.threadFailure = new Error("thread 3 crashed");
    const runner = await createRunner();

    const result = await runner.run(compressCommand());
    expect((result.error as Error).message).toBe("thread 3 crashed");
  });

  it("drains the thread spawner and rethrows when the fd build fails", async () => {
    harness.buildFdsError = new Error("mount build failed");
    const runner = await createRunner();

    await expect(runner.run(compressCommand())).rejects.toThrow("mount build failed");
    expect(harness.spawnerDrains).toBe(1);
  });

  it("swallows a scratch cleanup failure and traces it", async () => {
    harness.runScratchError = new Error("scratch listing failed");
    const traceLines: string[] = [];
    const runner = await createRunner();

    const result = await runner.run(compressCommand(), { onTraceNonJsonLine: (line) => traceLines.push(line) });

    expect(result.ok).toBe(true);
    expect(traceLines.some((line) => line.includes("run scratch cleanup failed"))).toBe(true);
  });

  it("invalidates the mount cache before the run only when asked", async () => {
    const traceLines: string[] = [];
    const runner = await createRunner();

    await runner.run(compressCommand(), { onTraceNonJsonLine: (line) => traceLines.push(line) });
    expect(traceLines.some((line) => line.includes("invalidate mount cache before run start"))).toBe(false);

    traceLines.length = 0;
    await runner.run(compressCommand(), {
      invalidateMountCacheBeforeRun: true,
      onTraceNonJsonLine: (line) => traceLines.push(line),
    });
    expect(traceLines.some((line) => line.includes("invalidate mount cache before run start"))).toBe(true);
    expect(traceLines.some((line) => line.includes("invalidate mount cache before run done"))).toBe(true);
  });

  it("emits the per-op timing and resource lines after teardown", async () => {
    const traceLines: string[] = [];
    const runner = await createRunner();
    await runner.run(compressCommand(), {
      onTraceNonJsonLine: (line) => traceLines.push(line),
      stagingMs: 12.5,
    });

    const timings = traceLines.find((line) => line.startsWith("[perf] command timings"));
    expect(timings).toContain("threads=4");
    expect(timings).toContain("exitCode=0");
    expect(timings).toContain("stagingMs=12.5");
    expect(timings).toContain("succeeded=true");
    expect(traceLines.some((line) => line.includes("[perf] opfs proxy handles live=1 peak=2 opened=4"))).toBe(true);
    expect(traceLines.some((line) => line.includes("[perf] thread workers created=n/a total=n/a"))).toBe(true);
  });

  it("reports n/a timings when the run never reached wasi.start", async () => {
    harness.spawnerReadyError = new Error("no worker");
    const traceLines: string[] = [];
    const runner = await createRunner();
    await runner.run(compressCommand(), { onTraceNonJsonLine: (line) => traceLines.push(line) });

    const timings = traceLines.find((line) => line.startsWith("[perf] command timings"));
    expect(timings).toContain("setupMs=n/a computeMs=n/a teardownMs=n/a");
    expect(timings).toContain("succeeded=false");
  });
});

describe("createRomWeaverBrowserOpfs run settings", () => {
  it("merges create-time and per-run known input paths, virtual files and mount handles", async () => {
    const runMount = makeRootHandle();
    const runner = await createRunner({
      knownInputPaths: ["/work/base.bin"],
      virtualFiles: [{ path: "/work/base.iso", source: new Uint8Array([1, 2]) }],
    });

    await runner.run(compressCommand(), {
      knownInputPaths: ["/work/run.bin"],
      mountHandles: { "/extra": runMount },
      virtualFiles: [{ path: "/work/run.iso", source: new Uint8Array([3]) }],
      virtualOnlyMounts: true,
    });

    const call = harness.buildFdsCalls[0];
    expect(call?.knownInputPaths).toEqual(["/work/base.bin", "/work/run.bin"]);
    expect(call?.virtualFiles.map((file) => file.path)).toEqual(["/work/base.iso", "/work/run.iso"]);
    expect(call?.mountHandles["/extra"]).toBe(runMount);
    expect(call?.virtualOnlyMounts).toBe(true);
  });

  it("registers proxy-handle Blob inputs for the run and unregisters them at teardown", async () => {
    const runner = await createRunner();
    await runner.run(compressCommand(), {
      virtualFiles: [
        { path: "/work/proxy.iso", source: new Blob([new Uint8Array([1, 2, 3])]), useProxyHandle: true },
        { path: "/work/direct.iso", source: new Uint8Array([4]) },
      ],
    });

    expect(harness.proxyRegistered).toEqual(["/work/proxy.iso"]);
    expect(harness.proxyUnregistered).toEqual(["/work/proxy.iso"]);
  });

  it("resolves the sync access mode from the run, then the runner, then the threading default", async () => {
    const plain = await createRunner();
    await plain.run(compressCommand());
    expect(harness.buildFdsCalls[0]?.syncAccessMode).toBeUndefined();

    await plain.run(compressCommand(), { syncAccessMode: "read-only" });
    expect(harness.buildFdsCalls[1]?.syncAccessMode).toBe("read-only");

    const configured = await createRunner({ syncAccessMode: "readwrite" });
    await configured.run(compressCommand());
    expect(harness.buildFdsCalls[2]?.syncAccessMode).toBe("readwrite");

    vi.stubGlobal("crossOriginIsolated", true);
    vi.spyOn(WebAssembly.Module, "imports").mockReturnValue(THREADED_IMPORTS);
    const threaded = await createRunner();
    await threaded.run(compressCommand());
    expect(harness.buildFdsCalls[3]?.syncAccessMode).toBe("readwrite-unsafe");
  });

  it("widens the writable roots with per-run writable directories", async () => {
    const runner = await createRunner({ writableDirectories: ["/work/out"] });
    await runner.run(compressCommand(), { writableDirectories: ["/work/tmp"] });

    expect(harness.buildFdsCalls[0]?.writableRoots).toEqual(["/work", "/work/out", "/work/tmp"]);
  });

  it("clamps and defaults the requested thread budget", async () => {
    const runner = await createRunner({ defaultThreads: 6 });

    await runner.run(compressCommand());
    expect(harness.buildFdsCalls[0]?.stdin).toContain('"threads":6');

    await runner.run(compressCommand({ threads: 512 }));
    expect(harness.buildFdsCalls[1]?.stdin).toContain('"threads":64');

    await runner.run(compressCommand(), { defaultThreads: "off" });
    expect(harness.buildFdsCalls[2]?.stdin).not.toContain("threads");
  });
});

describe("createRomWeaverBrowserOpfs threaded runs", () => {
  beforeEach(() => {
    vi.stubGlobal("crossOriginIsolated", true);
    vi.spyOn(WebAssembly.Module, "imports").mockReturnValue(THREADED_IMPORTS);
  });

  it("wires the thread-spawn import and a shared memory into the instance", async () => {
    const runner = await createRunner({ sharedMemoryInitialPages: 2 });
    await runner.run(compressCommand({ threads: 2 }));

    const wasiImports = instantiatedImports?.wasi as Record<string, unknown> | undefined;
    expect(typeof wasiImports?.["thread-spawn"]).toBe("function");
    const envImports = instantiatedImports?.env as Record<string, unknown> | undefined;
    expect(envImports?.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it("derives the rayon globals from the requested thread count and never overrides an explicit value", async () => {
    const runner = await createRunner();

    await runner.run(compressCommand({ threads: 3 }));
    expect(harness.spawnerArgs[0]?.envList).toContain("RAYON_NUM_THREADS=3");
    expect(harness.spawnerArgs[0]?.envList).toContain("RAYON_RS_NUM_CPUS=3");

    await runner.run(compressCommand({ threads: 32 }));
    expect(harness.spawnerArgs[1]?.envList).toContain("RAYON_NUM_THREADS=8");

    await runner.run(compressCommand({ threads: 3 }), { env: { RAYON_NUM_THREADS: "1" } });
    expect(harness.spawnerArgs[2]?.envList).toContain("RAYON_NUM_THREADS=1");
    expect(harness.spawnerArgs[2]?.envList.some((entry) => entry.startsWith("RAYON_RS_NUM_CPUS="))).toBe(false);
  });

  it("still drains the spawner when waiting for its workers fails", async () => {
    harness.spawnerWaitError = new Error("worker never acked");
    const runner = await createRunner();

    const result = await runner.run(compressCommand({ threads: 2 }));
    expect(result.ok).toBe(false);
    expect(harness.spawnerDrains).toBeGreaterThanOrEqual(1);
  });
});

describe("createRomWeaverBrowserOpfs runJson", () => {
  it("parses stdout JSON lines into events and non-JSON lines separately", async () => {
    harness.guestStdout = '{"kind":"progress"}\nplain stdout line\n';
    harness.guestStderr = '{"kind":"trace-event"}\nplain trace line\n';
    const events: unknown[] = [];
    const runner = await createRunner();

    const result = await runner.runJson(compressCommand(), { onEvent: (event) => events.push(event) });

    expect(result.events).toEqual([{ kind: "progress" }]);
    expect(result.nonJsonLines).toEqual(["plain stdout line"]);
    expect(result.traceEvents).toEqual([{ kind: "trace-event" }]);
    expect(result.traceNonJsonLines).toEqual(["plain trace line"]);
    expect(events).toEqual([{ kind: "progress" }]);
    expect(result.ok).toBe(true);
  });

  it("forces json output on the request it hands the guest", async () => {
    const runner = await createRunner();
    await runner.runJson(compressCommand());

    expect(JSON.parse(harness.buildFdsCalls[0]?.stdin ?? "{}")).toMatchObject({ output: { json: true } });
  });

  it("forwards the run output overrides", async () => {
    const runner = await createRunner();
    await runner.run(compressCommand(), {
      dep_trace: true,
      interactiveSelectionEnabled: true,
      log_level: "debug",
      progress: false,
    });

    expect(JSON.parse(harness.buildFdsCalls[0]?.stdin ?? "{}").output).toEqual({
      dep_trace: true,
      interactive_selection_enabled: true,
      log_level: "debug",
      progress: false,
    });
  });

  it("lets the snake_case interactive_selection_enabled override win", async () => {
    const runner = await createRunner();
    await runner.run(compressCommand(), {
      interactiveSelectionEnabled: true,
      interactive_selection_enabled: false,
    });

    expect(JSON.parse(harness.buildFdsCalls[0]?.stdin ?? "{}").output).toEqual({
      interactive_selection_enabled: false,
    });
  });
});

describe("createRomWeaverBrowserOpfs fd build inputs", () => {
  it("passes the work mount as the guest cwd and the runtime mount list", async () => {
    const runner = await createRunner({ workGuestPath: "/data" });
    await runner.run(compressCommand());

    expect(buildBrowserOpfsWasiFds).toHaveBeenCalledTimes(1);
    expect(harness.buildFdsCalls[0]?.cwdMountPath).toBe("/data");
    expect(harness.buildFdsCalls[0]?.runtimeMounts).toEqual(["/data"]);
  });
});
