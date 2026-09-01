import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInterruptedArchiveStressCase, runBrowserArchiveStress } from "../../src/wasm/browser-archive-stress.ts";
import type { RomWeaverRunJsonEvent } from "../../src/wasm/rom-weaver-types.d.ts";

const mocks = vi.hoisted(() => ({
  createBrowserWorkerClient: vi.fn(),
}));

vi.mock("../../src/wasm/workers/browser-worker-client.ts", () => ({
  createBrowserWorkerClient: mocks.createBrowserWorkerClient,
}));

const ACTIVE_CASE_KEY = "rom-weaver-ios-stress-active-case";

type StressCase = {
  compressedBytes: number;
  entryCount: number | null;
  expectedSha256: string | null;
  fileName: string;
  id: string;
  kind: "generated";
  sha256: string;
  uncompressedBytes: number | null;
  url: string;
};

const createCase = (overrides?: Partial<StressCase>): StressCase => ({
  compressedBytes: 128,
  entryCount: 1,
  expectedSha256: null,
  fileName: "corpus.zip",
  id: "many-entries",
  kind: "generated",
  sha256: "abc",
  uncompressedBytes: null,
  url: "/__rom_weaver_corpus__/many-entries.zip",
  ...overrides,
});

const createTerminalEvent = (overrides?: Partial<RomWeaverRunJsonEvent>) =>
  ({
    details: { emitted_files: [{ checksums: { sha256: "hash-1" }, size_bytes: 10 }] },
    effective_threads: 4,
    status: "succeeded",
    ...overrides,
  }) as unknown as RomWeaverRunJsonEvent;

type FakeStore = { removed: string[]; written: Array<{ path: string }> };

let store: FakeStore;
let workerClient: {
  init: ReturnType<typeof vi.fn>;
  runJson: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};
let localStorageBacking: Map<string, string>;

const createOpfsRoot = () => {
  const makeDirectory = (path: string): FileSystemDirectoryHandle =>
    ({
      getDirectoryHandle: (name: string) => Promise.resolve(makeDirectory(`${path}/${name}`)),
      getFileHandle: (name: string) =>
        Promise.resolve({
          createWritable: () => Promise.resolve({ path: `${path}/${name}` }),
        }),
      removeEntry: (name: string) => {
        store.removed.push(name);
        return Promise.resolve();
      },
    }) as unknown as FileSystemDirectoryHandle;
  return makeDirectory("");
};

const setManifest = (manifest: unknown, options?: { ok?: boolean; status?: number; statusText?: string }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).endsWith("manifest.json")) {
        return Promise.resolve({
          json: () => Promise.resolve(manifest),
          ok: options?.ok ?? true,
          status: options?.status ?? 200,
          statusText: options?.statusText ?? "OK",
          url: String(url),
        });
      }
      return Promise.resolve({
        body: {
          pipeTo: (writable: { path: string }) => {
            store.written.push({ path: writable.path });
            return Promise.resolve();
          },
        },
        ok: true,
        status: 200,
        url: String(url),
      });
    }),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  store = { removed: [], written: [] };
  localStorageBacking = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => localStorageBacking.get(key) ?? null,
    removeItem: (key: string) => {
      localStorageBacking.delete(key);
    },
    setItem: (key: string, value: string) => {
      localStorageBacking.set(key, value);
    },
  });
  vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(createOpfsRoot()) } });
  workerClient = {
    init: vi.fn(() => Promise.resolve({ ok: true })),
    runJson: vi.fn(),
    terminate: vi.fn(),
  };
  mocks.createBrowserWorkerClient.mockReturnValue(workerClient);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const runWithEvents = (
  events: RomWeaverRunJsonEvent[],
  result?: { exitCode?: number; ok?: boolean; stderr?: string },
) =>
  workerClient.runJson.mockImplementation(
    (_command: unknown, options: { onEvent?: (event: RomWeaverRunJsonEvent) => void }) => {
      for (const event of events) options.onEvent?.(event);
      return Promise.resolve({ exitCode: 0, ok: true, stderr: "", ...result });
    },
  );

describe("getInterruptedArchiveStressCase", () => {
  it("returns and clears a recorded active case", () => {
    localStorageBacking.set(ACTIVE_CASE_KEY, JSON.stringify({ id: "many-entries", startedAt: "2026-01-01T00:00:00Z" }));

    expect(getInterruptedArchiveStressCase()).toEqual({ id: "many-entries", startedAt: "2026-01-01T00:00:00Z" });
    expect(localStorageBacking.has(ACTIVE_CASE_KEY)).toBe(false);
  });

  it("ignores an absent, malformed, or wrong-shaped record", () => {
    expect(getInterruptedArchiveStressCase()).toBeNull();

    localStorageBacking.set(ACTIVE_CASE_KEY, "{not json");
    expect(getInterruptedArchiveStressCase()).toBeNull();

    localStorageBacking.set(ACTIVE_CASE_KEY, JSON.stringify({ id: 7, startedAt: "now" }));
    expect(getInterruptedArchiveStressCase()).toBeNull();
  });

  it("survives a storage that refuses to read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage denied");
      },
      removeItem: () => undefined,
      setItem: () => undefined,
    });

    expect(getInterruptedArchiveStressCase()).toBeNull();
  });
});

describe("runBrowserArchiveStress preflight", () => {
  it("refuses to start when the last case never finished", async () => {
    localStorageBacking.set(ACTIVE_CASE_KEY, JSON.stringify({ id: "budget-200", startedAt: "2026-01-01T00:00:00Z" }));

    await expect(runBrowserArchiveStress()).rejects.toThrow(
      "Previous archive case budget-200 was interrupted after 2026-01-01T00:00:00Z",
    );
  });

  it("reports a manifest the host would not serve", async () => {
    setManifest(null, { ok: false, status: 503, statusText: "Service Unavailable" });

    await expect(runBrowserArchiveStress()).rejects.toThrow("Archive corpus manifest failed: 503 Service Unavailable");
  });

  it("rejects a manifest with the wrong version or no case list", async () => {
    setManifest({ cases: [], generatedAt: "", version: 2 });
    await expect(runBrowserArchiveStress()).rejects.toThrow("Unsupported archive corpus manifest");

    setManifest({ cases: null, generatedAt: "", version: 1 });
    await expect(runBrowserArchiveStress()).rejects.toThrow("Unsupported archive corpus manifest");
  });

  it("reports when no case matches the requested ids", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });

    await expect(runBrowserArchiveStress({ caseIds: ["nope"] })).rejects.toThrow(
      'No archive corpus cases matched ["nope"]',
    );
  });

  it("reports an empty corpus, with or without an empty id filter", async () => {
    setManifest({ cases: [], generatedAt: "", version: 1 });

    await expect(runBrowserArchiveStress()).rejects.toThrow("No archive corpus cases matched []");
    await expect(runBrowserArchiveStress({ caseIds: [] })).rejects.toThrow("No archive corpus cases matched []");
  });
});

describe("runBrowserArchiveStress run", () => {
  it("stages the fixture, extracts it, and reports a passing step", async () => {
    setManifest({ cases: [createCase({ entryCount: 1, uncompressedBytes: 10 })], generatedAt: "", version: 1 });
    const terminal = createTerminalEvent();
    runWithEvents([terminal]);
    const steps: unknown[] = [];
    const events: unknown[] = [];

    const summary = await runBrowserArchiveStress({
      onEvent: (event) => events.push(event),
      onStep: (step) => steps.push(step),
    });

    expect(store.written).toHaveLength(1);
    expect(store.written[0]?.path).toMatch(/^\/rom-weaver-ios-stress-many-entries-\d+\/corpus\.zip$/);
    expect(workerClient.init).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMounts: ["/work"], workGuestPath: "/work" }),
    );
    expect(workerClient.runJson).toHaveBeenCalledTimes(1);
    expect(workerClient.terminate).toHaveBeenCalledTimes(1);
    expect(store.removed).toHaveLength(1);
    expect(events).toEqual([terminal]);
    expect(summary).toMatchObject({ failedSteps: 0, passedSteps: 1 });
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[0]).toMatchObject({ command: "extract", name: "many-entries", status: "running" });
    expect(summary.steps[1]).toMatchObject({
      name: "many-entries",
      status: "succeeded",
      terminalStatus: "succeeded",
    });
    expect(summary.steps[1]?.command).toMatch(/^extract ceiling=\d+ effectiveThreads=4$/);
    expect(steps).toEqual(summary.steps);
    expect(localStorageBacking.has(ACTIVE_CASE_KEY)).toBe(false);
  });

  it("labels an unknown thread count", async () => {
    setManifest({ cases: [createCase({ entryCount: null })], generatedAt: "", version: 1 });
    runWithEvents([createTerminalEvent({ effective_threads: undefined })]);

    const summary = await runBrowserArchiveStress();

    expect(summary.steps[1]?.command).toContain("effectiveThreads=unknown");
  });

  it("runs only the cases the caller named", async () => {
    setManifest({
      cases: [
        createCase({ entryCount: null, id: "a" }),
        createCase({ entryCount: null, id: "b" }),
        createCase({ entryCount: null, id: "c" }),
      ],
      generatedAt: "",
      version: 1,
    });
    runWithEvents([createTerminalEvent({ details: { emitted_files: [] } })]);

    const summary = await runBrowserArchiveStress({ caseIds: ["a", "c"] });

    expect(summary.steps.filter((step) => step.status === "succeeded").map((step) => step.name)).toEqual(["a", "c"]);
    expect(summary.passedSteps).toBe(2);
  });

  it("records a failed step and rethrows when the fixture cannot be fetched", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("manifest.json")
          ? Promise.resolve({
              json: () => Promise.resolve({ cases: [createCase()], generatedAt: "", version: 1 }),
              ok: true,
              status: 200,
              url: String(url),
            })
          : Promise.resolve({ ok: false, status: 404, url: String(url) }),
      ),
    );
    const steps: Array<{ error?: string; name: string; status: string }> = [];

    await expect(runBrowserArchiveStress({ onStep: (step) => steps.push(step) })).rejects.toThrow(
      "many-entries: fixture fetch failed with 404",
    );

    expect(steps.at(-1)).toMatchObject({
      error: "many-entries: fixture fetch failed with 404",
      name: "many-entries",
      status: "failed",
    });
    expect(workerClient.terminate).toHaveBeenCalledTimes(1);
    expect(store.removed).toHaveLength(1);
    expect(localStorageBacking.has(ACTIVE_CASE_KEY)).toBe(false);
  });

  it("reports a corpus response with no body", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("manifest.json")
          ? Promise.resolve({
              json: () => Promise.resolve({ cases: [createCase()], generatedAt: "", version: 1 }),
              ok: true,
              status: 200,
              url: String(url),
            })
          : Promise.resolve({ body: null, ok: true, status: 200, url: "/corpus.zip" }),
      ),
    );

    await expect(runBrowserArchiveStress()).rejects.toThrow("Corpus response has no body: /corpus.zip");
  });

  it("reports a command that emitted no events", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });
    runWithEvents([]);

    await expect(runBrowserArchiveStress()).rejects.toThrow("Archive stress command emitted no events");
  });

  it("prefers the terminal label, then stderr, then a generic message for a failed extract", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });

    runWithEvents([createTerminalEvent({ label: "archive truncated", status: "failed" })], { ok: false });
    await expect(runBrowserArchiveStress()).rejects.toThrow("many-entries: archive truncated");

    runWithEvents([createTerminalEvent({ status: "failed" })], { stderr: "worker aborted" });
    await expect(runBrowserArchiveStress()).rejects.toThrow("many-entries: worker aborted");

    runWithEvents([createTerminalEvent({ status: "failed" })], { exitCode: 2 });
    await expect(runBrowserArchiveStress()).rejects.toThrow("many-entries: extract failed");
  });

  it("stringifies a non-Error failure in the step record", async () => {
    setManifest({ cases: [createCase()], generatedAt: "", version: 1 });
    workerClient.runJson.mockRejectedValue("wasm trap");
    const steps: Array<{ error?: string }> = [];

    await expect(runBrowserArchiveStress({ onStep: (step) => steps.push(step) })).rejects.toBe("wasm trap");

    expect(steps.at(-1)?.error).toBe("wasm trap");
  });
});

describe("emitted file verification", () => {
  const runWithEmitted = async (testCase: Partial<StressCase>, details: unknown) => {
    setManifest({ cases: [createCase(testCase)], generatedAt: "", version: 1 });
    runWithEvents([createTerminalEvent({ details } as Partial<RomWeaverRunJsonEvent>)]);
    return runBrowserArchiveStress();
  };

  it("rejects a mismatched entry count", async () => {
    await expect(runWithEmitted({ entryCount: 3 }, { emitted_files: [{ size_bytes: 1 }] })).rejects.toThrow(
      "many-entries: expected 3 emitted files, got 1",
    );
  });

  it("rejects a mismatched output size", async () => {
    await expect(
      runWithEmitted({ entryCount: null, uncompressedBytes: 99 }, { emitted_files: [{ size_bytes: 1 }, {}] }),
    ).rejects.toThrow("many-entries: expected 99 output bytes, got 1");
  });

  it("rejects a mismatched extracted checksum", async () => {
    await expect(
      runWithEmitted(
        { entryCount: null, expectedSha256: "expected-hash" },
        { emitted_files: [{ checksums: { sha256: "other-hash" } }] },
      ),
    ).rejects.toThrow("many-entries: extracted sha256 did not match expected-hash");
  });

  it("rejects an emitted file that carries no checksums", async () => {
    await expect(
      runWithEmitted({ entryCount: null, expectedSha256: "expected-hash" }, { emitted_files: [{ size_bytes: 1 }] }),
    ).rejects.toThrow("many-entries: extracted sha256 did not match expected-hash");
  });

  it("accepts an emitted list that satisfies every declared expectation", async () => {
    const summary = await runWithEmitted(
      { entryCount: 2, expectedSha256: "hash", uncompressedBytes: 30 },
      {
        emitted_files: [
          { checksums: { sha256: "hash" }, size_bytes: 10 },
          { checksums: { sha256: "hash" }, size_bytes: 20 },
        ],
      },
    );

    expect(summary.passedSteps).toBe(1);
  });

  it("treats a non-object or array details payload as no emitted files", async () => {
    await expect(runWithEmitted({ entryCount: 1 }, [1, 2])).rejects.toThrow(
      "many-entries: expected 1 emitted files, got 0",
    );
    await expect(runWithEmitted({ entryCount: 1 }, null)).rejects.toThrow(
      "many-entries: expected 1 emitted files, got 0",
    );
    await expect(runWithEmitted({ entryCount: 1 }, { emitted_files: "nope" })).rejects.toThrow(
      "many-entries: expected 1 emitted files, got 0",
    );
  });
});
