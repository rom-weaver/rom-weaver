import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserFormatMatrixStep,
  createExhaustiveContainerCases,
  getBrowserFormatMatrixMetadataCoverage,
  runBrowserFullFormatMatrixCore,
  runBrowserFullFormatMatrix,
  summarizeBrowserFormatMatrixResult,
} from "../../src/wasm/browser-format-matrix.ts";
import { getRomWeaverCommandLabel } from "../../src/wasm/rom-weaver-command.ts";
import type { RomWeaverCommand } from "../../src/wasm/rom-weaver-types.d.ts";

const mocks = vi.hoisted(() => ({
  createBrowserWorkerClient: vi.fn(),
  readGuestFile: vi.fn(() => Promise.resolve(new Uint8Array(0))),
  removeFixtureDirectory: vi.fn(() => Promise.resolve()),
  waitForGuestFile: vi.fn(() => Promise.resolve()),
  resolveAppleMobileSharedMemoryMaximumPages: vi.fn((): number | null => null),
  writeGuestFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/wasm/workers/browser-worker-client.ts", () => ({
  createBrowserWorkerClient: mocks.createBrowserWorkerClient,
}));
vi.mock("../../src/lib/runtime/op-memory-estimate.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/runtime/op-memory-estimate.ts")>()),
  resolveAppleMobileSharedMemoryMaximumPages: mocks.resolveAppleMobileSharedMemoryMaximumPages,
}));
vi.mock("../../src/wasm/browser-matrix-guest-io.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/wasm/browser-matrix-guest-io.ts")>()),
  readGuestFile: mocks.readGuestFile,
  removeFixtureDirectory: mocks.removeFixtureDirectory,
  waitForGuestFile: mocks.waitForGuestFile,
  writeGuestFile: mocks.writeGuestFile,
}));

/** The smallest binary `new WebAssembly.Module` accepts: the magic number and version. */
const EMPTY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const inlineFixtures = {
  hdiffFixtures: { patch: "hdiff-patch", source: "hdiff-source", target: "hdiff-target" },
  vcdiffFixtures: { patch: "vcdiff-patch", source: "vcdiff-source", target: "vcdiff-target" },
};

let createdDirectories: string[];
let workers: Array<{
  init: ReturnType<typeof vi.fn>;
  runJson: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}>;

const createWorker = (options?: { initMode?: string; initError?: Error; runError?: Error }) => {
  const worker = {
    init: vi.fn(() =>
      options?.initError
        ? Promise.reject(options.initError)
        : Promise.resolve({ mode: options?.initMode ?? "browser-opfs" }),
    ),
    runJson: vi.fn(() => Promise.reject(options?.runError ?? new Error("worker offline"))),
    terminate: vi.fn(),
  };
  workers.push(worker);
  return worker;
};

beforeEach(() => {
  vi.clearAllMocks();
  createdDirectories = [];
  workers = [];
  mocks.resolveAppleMobileSharedMemoryMaximumPages.mockReturnValue(null);
  mocks.readGuestFile.mockResolvedValue(new Uint8Array(0));
  mocks.waitForGuestFile.mockResolvedValue(undefined);
  mocks.createBrowserWorkerClient.mockImplementation(() => createWorker());
  vi.stubGlobal("navigator", {
    storage: {
      getDirectory: () =>
        Promise.resolve({
          getDirectoryHandle: (name: string) => {
            createdDirectories.push(name);
            return Promise.resolve({});
          },
        }),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("summarizeBrowserFormatMatrixResult", () => {
  it("summarizes a result, a partial result, and nothing at all", () => {
    expect(summarizeBrowserFormatMatrixResult({ durationMs: 1200, failedSteps: 2, passedSteps: 8, steps: [] })).toBe(
      "passed=8 failed=2 durationMs=1200",
    );
    expect(summarizeBrowserFormatMatrixResult({ passedSteps: 3 })).toBe("passed=3 failed=0 durationMs=0");
    expect(summarizeBrowserFormatMatrixResult(null)).toBe("passed=0 failed=0 durationMs=0");
    expect(summarizeBrowserFormatMatrixResult(undefined)).toBe("passed=0 failed=0 durationMs=0");
  });
});

describe("createExhaustiveContainerCases", () => {
  it("expands every codec across the thread modes", () => {
    const cases = createExhaustiveContainerCases();

    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((entry) => entry.format))).toEqual(new Set(["7z", "chd", "z3ds", "zip"]));
    expect(new Set(cases.map((entry) => entry.threads))).toEqual(new Set([1, 2, "auto"]));
    // Every case is emitted once per thread mode, so the total is always a multiple of three.
    expect(cases.length % 3).toBe(0);
    for (const entry of cases) {
      expect(entry.codec).toBeTypeOf("string");
      if (entry.level !== undefined) expect(entry.level).toBeTypeOf("string");
    }
  });

  it("keeps the chd zlib floor above the codec's own minimum", () => {
    const chdZlibLevels = new Set(
      createExhaustiveContainerCases()
        .filter((entry) => entry.codec === "zlib" && entry.format === "chd")
        .map((entry) => entry.level),
    );

    expect(chdZlibLevels.size).toBeGreaterThan(0);
  });
});

describe("getBrowserFormatMatrixMetadataCoverage", () => {
  it("lists the format universe the matrix walks", () => {
    const coverage = getBrowserFormatMatrixMetadataCoverage();

    expect(coverage.containerFormats.length).toBeGreaterThan(0);
    expect(coverage.containerRoundTripFormats.length).toBeGreaterThan(0);
    expect(coverage.patchFormats.length).toBeGreaterThan(0);
    expect(coverage.exhaustiveContainerCodecs.length).toBeGreaterThan(0);
    // Round-trip and compress-failure formats partition the container universe.
    for (const format of coverage.containerRoundTripFormats) {
      expect(coverage.containerCompressFailureFormats).not.toContain(format);
    }
    expect(new Set([...coverage.containerRoundTripFormats, ...coverage.containerCompressFailureFormats])).toEqual(
      new Set(coverage.containerFormats),
    );
  });
});

describe("runBrowserFullFormatMatrix", () => {
  it("stands up the fixture directory, drives the core, and always cleans up", async () => {
    const steps: BrowserFormatMatrixStep[] = [];

    await expect(runBrowserFullFormatMatrix({ ...inlineFixtures, onStep: (step) => steps.push(step) })).rejects.toThrow(
      "worker offline",
    );

    expect(createdDirectories).toHaveLength(1);
    expect(createdDirectories[0]).toMatch(/^rom-weaver-browser-format-matrix-\d+-[0-9a-f]+$/);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.init).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMounts: ["/work"], workGuestPath: "/work" }),
    );
    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.removeFixtureDirectory).toHaveBeenCalledWith(expect.anything(), createdDirectories[0]);
    expect(steps[0]).toMatchObject({ command: "compress", status: "running" });
    expect(steps[1]).toMatchObject({ command: "compress", status: "failed" });
    expect(steps[1]?.error).toContain("worker offline");
  });

  it("writes the source file and both patch fixture sets before running", async () => {
    await expect(
      runBrowserFullFormatMatrix({
        ...inlineFixtures,
        sourceContents: "custom source",
        sourceFileName: "seed.bin",
      }),
    ).rejects.toThrow("worker offline");

    const writtenPaths = mocks.writeGuestFile.mock.calls.map((call) => String(call[1]));
    expect(writtenPaths[0]).toMatch(/\/seed\.bin$/);
    expect(writtenPaths.slice(1, 7).map((path) => path.split("/").at(-1))).toEqual([
      "secondary-source.bin",
      "secondary-djw.xdelta",
      "secondary-target.bin",
      "hdiff-source.bin",
      "upstream-hdiff13-zstd.hdiff",
      "hdiff-target.bin",
    ]);
    expect(new TextDecoder().decode(mocks.writeGuestFile.mock.calls[0]?.[2] as Uint8Array)).toBe("custom source");
  });

  it("honours a caller-supplied prefix and wasm url", async () => {
    await expect(
      runBrowserFullFormatMatrix({ ...inlineFixtures, prefix: "custom-prefix-", wasmUrl: "https://cdn.test/app.wasm" }),
    ).rejects.toThrow("worker offline");

    expect(createdDirectories[0]).toMatch(/^custom-prefix-/);
    expect(workers[0]?.init).toHaveBeenCalledWith(expect.objectContaining({ wasmUrl: "https://cdn.test/app.wasm" }));
  });

  it("rejects a worker that did not come up in browser-opfs mode", async () => {
    mocks.createBrowserWorkerClient.mockImplementation(() => createWorker({ initMode: "node" }));

    await expect(runBrowserFullFormatMatrix(inlineFixtures)).rejects.toThrow(
      "expected browser-opfs init mode, got node",
    );

    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.removeFixtureDirectory).toHaveBeenCalledTimes(1);
  });

  it("terminates a worker whose init rejected", async () => {
    mocks.createBrowserWorkerClient.mockImplementation(() => createWorker({ initError: new Error("init blew up") }));

    await expect(runBrowserFullFormatMatrix(inlineFixtures)).rejects.toThrow("init blew up");

    expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
  });

  it("survives a terminate that throws while cleaning up", async () => {
    mocks.createBrowserWorkerClient.mockImplementation(() => {
      const worker = createWorker();
      worker.terminate.mockImplementation(() => {
        throw new Error("terminate blew up");
      });
      return worker;
    });

    await expect(runBrowserFullFormatMatrix(inlineFixtures)).rejects.toThrow("worker offline");

    expect(mocks.removeFixtureDirectory).toHaveBeenCalledTimes(1);
  });

  describe("apple mobile shared memory", () => {
    beforeEach(() => {
      mocks.resolveAppleMobileSharedMemoryMaximumPages.mockReturnValue(2048);
    });

    it("compiles the module once and spawns a worker per command", async () => {
      const compiled = new WebAssembly.Module(EMPTY_WASM);
      const compileStreaming = vi.spyOn(WebAssembly, "compileStreaming").mockResolvedValue(compiled);
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve({ ok: true })),
      );

      await expect(runBrowserFullFormatMatrix(inlineFixtures)).rejects.toThrow("worker offline");

      expect(compileStreaming).toHaveBeenCalledTimes(1);
      expect(workers).toHaveLength(1);
      expect(workers[0]?.init).toHaveBeenCalledWith(
        expect.objectContaining({ module: compiled, sharedMemoryMaximumPages: 2048 }),
      );
      expect(workers[0]?.terminate).toHaveBeenCalledTimes(1);
    });

    it("reuses a module the caller already compiled", async () => {
      const compiled = new WebAssembly.Module(EMPTY_WASM);
      const compileStreaming = vi
        .spyOn(WebAssembly, "compileStreaming")
        .mockRejectedValue(new Error("should not compile"));

      await expect(
        runBrowserFullFormatMatrix({ ...inlineFixtures, initOptions: { module: compiled } }),
      ).rejects.toThrow("worker offline");

      expect(compileStreaming).not.toHaveBeenCalled();
      expect(workers[0]?.init).toHaveBeenCalledWith(expect.objectContaining({ module: compiled }));
    });
  });

  it("walks the container round trips and the exhaustive option grid when every command succeeds", async () => {
    mocks.createBrowserWorkerClient.mockImplementation(() => {
      const worker = createWorker();
      worker.runJson.mockImplementation((command: RomWeaverCommand) =>
        Promise.resolve({
          events: [{ command: getRomWeaverCommandLabel(command), status: "succeeded" }],
          exitCode: 0,
          ok: true,
          stderr: "",
        }),
      );
      return worker;
    });
    const steps: BrowserFormatMatrixStep[] = [];

    // Canned successes carry no real output bytes, so the matrix still fails at
    // its first content assertion; the point is the walk it makes before then.
    await expect(
      runBrowserFullFormatMatrix({ ...inlineFixtures, onStep: (step) => steps.push(step), profile: "exhaustive" }),
    ).rejects.toThrow();

    const succeeded = steps.filter((step) => step.status === "succeeded").map((step) => step.name);
    expect(succeeded.some((name) => name.startsWith("compress "))).toBe(true);
    expect(succeeded.some((name) => name.startsWith("ingest "))).toBe(true);
    expect(succeeded.filter((name) => name.includes("threads=2")).length).toBeGreaterThan(0);
    expect(succeeded.filter((name) => name.includes("threads=auto")).length).toBeGreaterThan(0);
    expect(succeeded.some((name) => name.startsWith("ingest options "))).toBe(true);
    expect(mocks.removeFixtureDirectory).toHaveBeenCalledTimes(1);
  });

  it("completes the fast matrix with format-specific failures and patch fixtures", async () => {
    const steps: BrowserFormatMatrixStep[] = [];
    const coverage = getBrowserFormatMatrixMetadataCoverage();
    const containerFailures = new Set(coverage.containerCompressFailureFormats);
    let expectedFailures = 0;
    const readBytes = (path: string) => {
      if (
        path.endsWith("fixture-applied-hdiffpatch.bin") ||
        path.endsWith("hdiff-target.bin") ||
        path.endsWith("hdiff.target")
      ) {
        return new Uint8Array([7, 8]);
      }
      if (path.endsWith("fixture-applied-bsp.bin")) return new Uint8Array([0xff, 2, 3]);
      return new Uint8Array([1, 2, 3]);
    };
    mocks.readGuestFile.mockImplementation((_, path: string) => Promise.resolve(readBytes(path)));

    const runJson = vi.fn(async (command: RomWeaverCommand, options?: { onEvent?: (event: unknown) => void }) => {
      const commandName = getRomWeaverCommandLabel(command);
      const args = command.type === "patch" ? command.args.args : command.args;
      const format = String((args as { format?: unknown }).format || "");
      const inputPath = String((args as { input?: unknown }).input || "");
      let failureLabel: string | undefined;
      if (commandName === "compress" && containerFailures.has(format)) {
        failureLabel = format === "rvz" ? "failed to open input" : "extract-only format";
      } else if (commandName === "ingest" && inputPath.includes("extract-")) {
        const specialExtractFormat = ["gcz", "wbfs", "wia", "tgc", "nfs", "rvz"].find((name) =>
          inputPath.includes(`extract-${name}.`),
        );
        if (specialExtractFormat) {
          failureLabel = `failed to open ${specialExtractFormat} source`;
        } else if (inputPath.includes("extract-pbp.")) {
          failureLabel = "too small to be a pbp container";
        } else if (inputPath.includes("extract-xiso.")) {
          failureLabel = "not an Xbox XDVDFS image";
        } else {
          failureLabel = "archive is invalid";
        }
      } else if (commandName === "patch-create") {
        if (format === "hdiffpatch") failureLabel = "creation is disabled";
        if (format === "ninja1") failureLabel = "not currently supported";
        if (format === "bsp") failureLabel = "creation is not implemented";
        if (["aps", "bdf", "dldi"].includes(format)) failureLabel = "i/o error: unsupported";
      }
      if (failureLabel) expectedFailures += 1;
      const status = failureLabel ? "failed" : "succeeded";
      const event = {
        command: commandName,
        label: failureLabel || `running ${commandName}`,
        percent: commandName === "patch-apply" ? 50 : undefined,
        stage: commandName === "patch-apply" ? "apply" : undefined,
        format: commandName === "patch-apply" ? "xdelta" : undefined,
        status: "running",
      };
      options?.onEvent?.(event);
      const terminal = {
        command: commandName,
        label: failureLabel || "done",
        status: ["hdiffpatch", "ninja1", "bsp"].includes(format) ? "unsupported" : status,
      };
      return {
        events: failureLabel ? [terminal] : [event, terminal],
        exitCode: failureLabel ? 1 : 0,
        ok: !failureLabel,
        stderr: failureLabel || "",
      };
    });

    const result = await runBrowserFullFormatMatrixCore({
      dir: "/work/matrix",
      fixtures: {
        hdiffPatchPath: "/work/matrix/fixtures/hdiff.patch",
        hdiffSourcePath: "/work/matrix/fixtures/hdiff.source",
        hdiffTargetPath: "/work/matrix/fixtures/hdiff.target",
        vcdiffPatchPath: "/work/matrix/fixtures/vcdiff.patch",
        vcdiffSourcePath: "/work/matrix/fixtures/vcdiff.source",
        vcdiffTargetPath: "/work/matrix/fixtures/vcdiff.target",
      },
      onEvent: (event) => steps.push({ ...(event as never) }),
      onStep: (step) => steps.push(step),
      opfsHandle: {} as FileSystemDirectoryHandle,
      runJson,
      sourcePath: "/work/matrix/input.bin",
    });

    expect(result.failedSteps).toBe(0);
    expect(result.passedSteps).toBeGreaterThan(0);
    expect(expectedFailures).toBeGreaterThan(0);
    expect(runJson).toHaveBeenCalled();
    expect(steps.some((step) => step.command === "patch-apply" && step.status === "running")).toBe(true);
    expect(mocks.waitForGuestFile).toHaveBeenCalled();
    expect(mocks.writeGuestFile).toHaveBeenCalled();
  });

  describe("fixture loading", () => {
    it("fetches the default fixtures when the caller supplies none", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)), ok: true }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(runBrowserFullFormatMatrix({})).rejects.toThrow("worker offline");

      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it("reports a fixture the host would not serve", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve({ ok: false, status: 404, statusText: "Not Found" })),
      );

      await expect(runBrowserFullFormatMatrix({})).rejects.toThrow(/failed to fetch fixture .*: 404 Not Found/);
      expect(mocks.removeFixtureDirectory).toHaveBeenCalledTimes(1);
    });

    it("accepts fixture bytes and urls the caller overrides", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)), ok: true }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        runBrowserFullFormatMatrix({
          hdiffFixtureUrls: { patch: new URL("https://cdn.test/h.patch") },
          vcdiffFixtures: { source: Uint8Array.from([1, 2]), target: new ArrayBuffer(3) },
        }),
      ).rejects.toThrow("worker offline");

      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain("https://cdn.test/h.patch");
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });
});
