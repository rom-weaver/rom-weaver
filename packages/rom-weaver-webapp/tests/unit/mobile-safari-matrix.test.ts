// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "../../src/wasm/browser-format-matrix.ts";
import type { BrowserRuntimeDiagnostics } from "../../src/webapp/browser-runtime-diagnostics.ts";

const mocks = vi.hoisted(() => ({
  collectBrowserRuntimeDiagnostics: vi.fn(),
  getInterruptedArchiveStressCase: vi.fn(),
  getInterruptedMemoryGrowthRun: vi.fn(),
  runBrowserArchiveStress: vi.fn(),
  runBrowserFullFormatMatrix: vi.fn(),
  runBrowserMemoryGrowthProbe: vi.fn(),
  runBrowserSharedMemoryProbe: vi.fn(),
  runBrowserThreadSweep: vi.fn(),
  summarizeBrowserFormatMatrixResult: vi.fn(),
}));

vi.mock("../../src/wasm/browser-archive-stress.ts", () => ({
  getInterruptedArchiveStressCase: mocks.getInterruptedArchiveStressCase,
  runBrowserArchiveStress: mocks.runBrowserArchiveStress,
}));
vi.mock("../../src/wasm/browser-format-matrix.ts", () => ({
  runBrowserFullFormatMatrix: mocks.runBrowserFullFormatMatrix,
  summarizeBrowserFormatMatrixResult: mocks.summarizeBrowserFormatMatrixResult,
}));
vi.mock("../../src/wasm/browser-memory-growth-probe.ts", () => ({
  getInterruptedMemoryGrowthRun: mocks.getInterruptedMemoryGrowthRun,
  runBrowserMemoryGrowthProbe: mocks.runBrowserMemoryGrowthProbe,
}));
vi.mock("../../src/wasm/browser-shared-memory-probe.ts", () => ({
  runBrowserSharedMemoryProbe: mocks.runBrowserSharedMemoryProbe,
}));
vi.mock("../../src/wasm/browser-thread-sweep.ts", () => ({
  runBrowserThreadSweep: mocks.runBrowserThreadSweep,
}));
vi.mock("../../src/webapp/browser-runtime-diagnostics.ts", () => ({
  collectBrowserRuntimeDiagnostics: mocks.collectBrowserRuntimeDiagnostics,
}));

type MatrixCallbacks = {
  onEvent: (event: { status?: string; type: string }) => void;
  onStep: (step: BrowserFormatMatrixStep) => void;
};

const SKELETON = [
  '<div id="matrix-summary"></div>',
  '<pre id="matrix-log"></pre>',
  '<button id="matrix-run"></button>',
  '<button id="matrix-run-exhaustive"></button>',
  '<button id="matrix-run-stress"></button>',
  '<button id="matrix-run-threads"></button>',
  '<button id="matrix-run-memory"></button>',
  '<button id="matrix-run-growth"></button>',
  '<button id="matrix-copy"></button>',
  '<button id="matrix-download"></button>',
].join("");

const createDiagnostics = (overrides?: Partial<BrowserRuntimeDiagnostics>): BrowserRuntimeDiagnostics => ({
  atomicsWaitAsync: "function",
  blobArrayBuffer: "function",
  cacheStorage: "object",
  crossOriginIsolated: true,
  deviceMemory: 8,
  file: "function",
  fileSystemFileHandle: "function",
  fileSystemSyncAccessHandle: "function",
  headers: {
    crossOriginEmbedderPolicy: "require-corp",
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-origin",
  },
  href: "https://rom-weaver.test/mobile-safari-matrix.html",
  isSecureContext: true,
  maxTouchPoints: 5,
  mobileSafariCandidate: true,
  opfs: { available: true, ok: true },
  platform: "iPhone",
  serviceWorker: "object",
  serviceWorkerController: true,
  sharedArrayBuffer: "function",
  storageEstimate: { quota: 1000, usage: 10 },
  timestamp: "2026-01-01T00:00:00.000Z",
  userAgent: "Mozilla/5.0 (iPhone)",
  webAssembly: "object",
  worker: "function",
  ...overrides,
});

const createSummary = (overrides?: Partial<BrowserFormatMatrixSummary>): BrowserFormatMatrixSummary => ({
  durationMs: 2000,
  failedSteps: 0,
  passedSteps: 2,
  steps: [],
  ...overrides,
});

const createSentinel = () => {
  const listeners: Array<() => void> = [];
  const sentinel = {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "release") listeners.push(listener);
    },
    emitRelease: () => {
      sentinel.released = true;
      for (const listener of listeners.splice(0)) listener();
    },
    release: vi.fn(() => {
      sentinel.released = true;
      return Promise.resolve();
    }),
    released: false,
  };
  return sentinel;
};

const setWakeLock = (value: unknown) => {
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value });
};

let clipboardWriteText = vi.fn((_text: string) => Promise.resolve());

const setClipboard = (writeText: (text: string) => Promise<void>) => {
  clipboardWriteText = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboardWriteText } });
};

const flush = async () => {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
};

const getApi = () => {
  const api = window.ROM_WEAVER_IOS_SAFARI_MATRIX;
  if (!api) throw new Error("the matrix harness did not install its window API");
  return api;
};

const loadMatrix = async (options?: { search?: string; skeleton?: string }) => {
  vi.resetModules();
  window.history.replaceState({}, "", `/mobile-safari-matrix.html${options?.search ?? ""}`);
  document.body.innerHTML = options?.skeleton ?? SKELETON;
  await import("../../src/webapp/mobile-safari-matrix.ts");
  await flush();
  return getApi();
};

const logLines = () => (document.getElementById("matrix-log")?.textContent ?? "").split("\n");

const summaryMetrics = () =>
  Object.fromEntries(
    Array.from(document.querySelectorAll("#matrix-summary .metric")).map((metric) => [
      metric.querySelector("strong")?.textContent ?? "",
      metric.querySelector("span")?.textContent ?? "",
    ]),
  );

const button = (id: string) => {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`missing button ${id}`);
  return element;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collectBrowserRuntimeDiagnostics.mockResolvedValue(createDiagnostics());
  mocks.getInterruptedArchiveStressCase.mockReturnValue(null);
  mocks.getInterruptedMemoryGrowthRun.mockReturnValue(null);
  mocks.summarizeBrowserFormatMatrixResult.mockReturnValue("2 passed, 0 failed");
  mocks.runBrowserArchiveStress.mockResolvedValue(createSummary());
  mocks.runBrowserFullFormatMatrix.mockResolvedValue(createSummary());
  mocks.runBrowserMemoryGrowthProbe.mockResolvedValue(createSummary());
  mocks.runBrowserSharedMemoryProbe.mockResolvedValue(createSummary());
  mocks.runBrowserThreadSweep.mockResolvedValue(createSummary());
  setWakeLock(undefined);
  setClipboard(vi.fn(() => Promise.resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("boot", () => {
  it("installs the window API and renders an idle summary from the runtime diagnostics", async () => {
    const api = await loadMatrix();

    expect(api.getReport()).toMatchObject({
      finishedAt: null,
      lastEvent: null,
      profile: "fast",
      result: null,
      startedAt: null,
      status: "idle",
      steps: [],
      version: 1,
    });
    expect(summaryMetrics()).toEqual({
      Duration: "",
      "Failed steps": "0",
      Isolated: "yes",
      "Mobile Safari": "yes",
      OPFS: "ok",
      "Passed steps": "0",
      Profile: "fast",
      Secure: "yes",
      Status: "idle",
    });
    expect(logLines()[0]).toMatch(/^diagnostics \{/);
    expect(JSON.parse(logLines()[0]?.replace("diagnostics ", "") ?? "{}")).toEqual({
      atomicsWaitAsync: "function",
      crossOriginEmbedderPolicy: "require-corp",
      crossOriginIsolated: true,
      crossOriginOpenerPolicy: "same-origin",
      isSecureContext: true,
      mobileSafariCandidate: true,
      opfs: { available: true, ok: true },
      sharedArrayBuffer: "function",
    });
  });

  it("reports a blocked runtime in the summary", async () => {
    mocks.collectBrowserRuntimeDiagnostics.mockResolvedValue(
      createDiagnostics({
        crossOriginIsolated: false,
        headers: null,
        isSecureContext: false,
        mobileSafariCandidate: false,
        opfs: { available: false, error: "denied", ok: false },
      }),
    );

    await loadMatrix();

    expect(summaryMetrics()).toMatchObject({
      Isolated: "no",
      "Mobile Safari": "no",
      OPFS: "blocked",
      Secure: "no",
    });
    expect(JSON.parse(logLines()[0]?.replace("diagnostics ", "") ?? "{}")).toMatchObject({
      crossOriginEmbedderPolicy: null,
      crossOriginOpenerPolicy: null,
    });
  });

  it("reads a known profile off the query string and falls back to fast", async () => {
    expect((await loadMatrix({ search: "?profile=stress" })).getReport().profile).toBe("stress");
    expect((await loadMatrix({ search: "?profile=nope" })).getReport().profile).toBe("fast");
    expect((await loadMatrix()).getReport().profile).toBe("fast");
  });

  it("records a failed diagnostics probe", async () => {
    mocks.collectBrowserRuntimeDiagnostics.mockRejectedValue(new Error("probe blew up"));

    const api = await loadMatrix();

    expect(api.getReport()).toMatchObject({ diagnostics: null, status: "diagnostics failed" });
    expect(logLines()).toContain("diagnostics failed probe blew up");
  });

  it("stringifies a non-Error diagnostics rejection", async () => {
    mocks.collectBrowserRuntimeDiagnostics.mockRejectedValue("probe vanished");

    await loadMatrix();

    expect(logLines()).toContain("diagnostics failed probe vanished");
  });

  it("refreshes the diagnostics on demand", async () => {
    const api = await loadMatrix();
    mocks.collectBrowserRuntimeDiagnostics.mockResolvedValue(createDiagnostics({ mobileSafariCandidate: false }));

    const diagnostics = await api.collectDiagnostics();

    expect(diagnostics.mobileSafariCandidate).toBe(false);
    expect(summaryMetrics()["Mobile Safari"]).toBe("no");
  });
});

describe("runs", () => {
  it("logs every step of a passing matrix run", async () => {
    mocks.runBrowserFullFormatMatrix.mockImplementation((options: MatrixCallbacks) => {
      options.onEvent({ status: "succeeded", type: "run-complete" });
      options.onStep({ command: "extract", name: "zip", status: "running", timestamp: "t" });
      options.onStep({ command: "", durationMs: 500, name: "zip", status: "succeeded", timestamp: "t" });
      options.onStep({
        command: "extract",
        durationMs: 1500,
        error: "bad magic",
        name: "7z",
        status: "failed",
        terminalStatus: "succeeded",
        timestamp: "t",
      });
      options.onStep({
        command: "threads=4",
        durationMs: 100,
        name: "sweep",
        status: "succeeded",
        terminalStatus: "succeeded",
        timestamp: "t",
      });
      options.onStep({ command: "", durationMs: 65_000, name: "slow", status: "succeeded", timestamp: "t" });
      options.onStep({
        command: "",
        durationMs: Number.POSITIVE_INFINITY,
        name: "endless",
        status: "succeeded",
        timestamp: "t",
      });
      options.onStep({ command: "", name: "untimed", status: "succeeded", timestamp: "t" });
      return Promise.resolve(createSummary({ durationMs: 2000, failedSteps: 0, passedSteps: 6 }));
    });
    const api = await loadMatrix();

    await api.run("fast");

    expect(mocks.runBrowserFullFormatMatrix).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "rom-weaver-ios-safari-matrix-", profile: "fast" }),
    );
    expect(api.getReport()).toMatchObject({
      lastEvent: { status: "succeeded", type: "run-complete" },
      profile: "fast",
      status: "passed",
    });
    expect(api.getReport().steps).toHaveLength(7);
    expect(api.getReport().startedAt).toEqual(expect.any(String));
    expect(api.getReport().finishedAt).toEqual(expect.any(String));
    const lines = logLines();
    expect(lines[0]).toBe("starting fast matrix");
    expect(lines[1]).toBe("wake lock unavailable; keep this page visible");
    expect(lines[2]).toMatch(/^diagnostics \{/);
    expect(lines.slice(3)).toEqual([
      "run zip",
      "succeeded zip 500ms",
      "failed/succeeded 7z 1.5s extract bad magic",
      "succeeded sweep 100ms threads=4",
      "succeeded slow 1m 5s",
      "succeeded endless ",
      "succeeded untimed ",
      "matrix passed 2 passed, 0 failed",
    ]);
    expect(summaryMetrics()).toMatchObject({
      Duration: "2.0s",
      "Failed steps": "0",
      "Passed steps": "6",
      Status: "passed",
    });
    expect(button("matrix-copy").disabled).toBe(false);
    expect(button("matrix-download").disabled).toBe(false);
    expect(button("matrix-run").disabled).toBe(false);
  });

  it("fails a run whose summary tallies a failed step", async () => {
    mocks.runBrowserFullFormatMatrix.mockResolvedValue(createSummary({ failedSteps: 1, passedSteps: 1 }));
    const api = await loadMatrix();

    await api.run("fast");

    expect(api.getReport().status).toBe("failed");
    expect(logLines()).toContain("matrix failed 2 passed, 0 failed");
  });

  it("refuses to start when the runtime preflight fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.collectBrowserRuntimeDiagnostics.mockResolvedValue(
      createDiagnostics({ opfs: { available: false, ok: false }, sharedArrayBuffer: "undefined" }),
    );
    const api = await loadMatrix();

    await api.run("fast");

    expect(mocks.runBrowserFullFormatMatrix).not.toHaveBeenCalled();
    expect(api.getReport()).toMatchObject({
      result: { failedSteps: 1, passedSteps: 0, steps: [] },
      status: "failed",
    });
    expect(logLines()).toContain("failed Runtime preflight failed: SharedArrayBuffer, OPFS");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(button("matrix-copy").disabled).toBe(false);
  });

  it("keeps the steps a crashing run already reported", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runBrowserFullFormatMatrix.mockImplementation((options: MatrixCallbacks) => {
      options.onStep({ command: "", durationMs: 5, name: "zip", status: "succeeded", timestamp: "t" });
      options.onStep({ command: "", durationMs: 5, name: "7z", status: "failed", timestamp: "t" });
      return Promise.reject(new Error("worker died"));
    });
    const api = await loadMatrix();

    await api.run("fast");

    expect(api.getReport()).toMatchObject({
      result: { failedSteps: 1, passedSteps: 1 },
      status: "failed",
    });
    expect(api.getReport().result?.steps).toHaveLength(2);
    expect(logLines()).toContain("failed worker died");
  });

  it("stringifies a non-Error run failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.runBrowserFullFormatMatrix.mockRejectedValue("wasm trap");
    const api = await loadMatrix();

    await api.run("fast");

    expect(logLines()).toContain("failed wasm trap");
  });

  it("clears the previous run before starting the next", async () => {
    const api = await loadMatrix();

    await api.run("fast");
    await api.run("exhaustive");

    expect(mocks.runBrowserFullFormatMatrix).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: "exhaustive" }),
    );
    expect(logLines()[0]).toBe("starting exhaustive matrix");
    expect(api.getReport().profile).toBe("exhaustive");
  });

  it("caps the log at 220 lines", async () => {
    mocks.runBrowserFullFormatMatrix.mockImplementation((options: MatrixCallbacks) => {
      for (let index = 0; index < 300; index += 1) {
        options.onStep({ command: "", durationMs: 1, name: `step-${index}`, status: "succeeded", timestamp: "t" });
      }
      return Promise.resolve(createSummary());
    });
    const api = await loadMatrix();

    await api.run("fast");

    const lines = logLines();
    expect(lines).toHaveLength(220);
    expect(lines[0]).toBe("succeeded step-81 1ms");
    expect(lines.at(-1)).toBe("matrix passed 2 passed, 0 failed");
  });

  it("runs without a summary or log element", async () => {
    const api = await loadMatrix({ skeleton: "" });

    await api.run("fast");

    expect(api.getReport()).toMatchObject({ profile: "fast", status: "passed" });
  });
});

describe("profile routing", () => {
  it("sends the stress profile the case ids from the query string", async () => {
    const api = await loadMatrix({ search: "?cases=many-entries, budget-200 ,," });

    await api.run("stress");

    expect(mocks.runBrowserArchiveStress).toHaveBeenCalledWith(
      expect.objectContaining({ caseIds: ["many-entries", "budget-200"] }),
    );
  });

  it("sends an empty case list when the query string names none", async () => {
    const api = await loadMatrix();

    await api.run("stress");

    expect(mocks.runBrowserArchiveStress).toHaveBeenCalledWith(expect.objectContaining({ caseIds: [] }));
  });

  it("routes the probe profiles to their own harnesses", async () => {
    const api = await loadMatrix();
    const callbacks = expect.objectContaining({ onEvent: expect.any(Function), onStep: expect.any(Function) });

    await api.run("threads");
    await api.run("memory");
    await api.run("growth");

    expect(mocks.runBrowserThreadSweep).toHaveBeenCalledWith(callbacks);
    expect(mocks.runBrowserSharedMemoryProbe).toHaveBeenCalledWith(callbacks);
    expect(mocks.runBrowserMemoryGrowthProbe).toHaveBeenCalledWith(callbacks);
    expect(mocks.runBrowserFullFormatMatrix).not.toHaveBeenCalled();
  });

  it("defaults to the fast profile", async () => {
    const api = await loadMatrix({ search: "?profile=stress" });

    await api.run();

    expect(mocks.runBrowserFullFormatMatrix).toHaveBeenCalledWith(expect.objectContaining({ profile: "fast" }));
  });
});

describe("buttons", () => {
  it("starts the profile its button names", async () => {
    await loadMatrix();

    button("matrix-run").click();
    await flush();
    expect(mocks.runBrowserFullFormatMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ profile: "fast" }));

    button("matrix-run-exhaustive").click();
    await flush();
    expect(mocks.runBrowserFullFormatMatrix).toHaveBeenLastCalledWith(
      expect.objectContaining({ profile: "exhaustive" }),
    );

    button("matrix-run-stress").click();
    await flush();
    expect(mocks.runBrowserArchiveStress).toHaveBeenCalledTimes(1);

    button("matrix-run-threads").click();
    await flush();
    expect(mocks.runBrowserThreadSweep).toHaveBeenCalledTimes(1);

    button("matrix-run-memory").click();
    await flush();
    expect(mocks.runBrowserSharedMemoryProbe).toHaveBeenCalledTimes(1);

    button("matrix-run-growth").click();
    await flush();
    expect(mocks.runBrowserMemoryGrowthProbe).toHaveBeenCalledTimes(1);
  });

  it("disables every control while a run is in flight", async () => {
    let finishRun = (summary: BrowserFormatMatrixSummary) => summary;
    mocks.runBrowserFullFormatMatrix.mockReturnValue(
      new Promise<BrowserFormatMatrixSummary>((resolve) => {
        finishRun = (summary) => {
          resolve(summary);
          return summary;
        };
      }),
    );
    const api = await loadMatrix();

    const run = api.run("fast");
    await flush();
    expect(button("matrix-run").disabled).toBe(true);
    expect(button("matrix-copy").disabled).toBe(true);
    expect(button("matrix-download").disabled).toBe(true);

    finishRun(createSummary());
    await run;
    expect(button("matrix-run").disabled).toBe(false);
  });
});

describe("report export", () => {
  it("copies the report to the clipboard", async () => {
    const api = await loadMatrix();

    await api.copyReport();

    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(clipboardWriteText.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      profile: "fast",
      status: "idle",
      version: 1,
    });
    expect(logLines()).toContain("report copied");
  });

  it("logs a clipboard failure from the copy button", async () => {
    setClipboard(() => Promise.reject(new Error("clipboard denied")));
    await loadMatrix();

    button("matrix-copy").click();
    await flush();

    expect(logLines()).toContain("copy failed clipboard denied");
  });

  it("stringifies a non-Error clipboard failure", async () => {
    setClipboard(() => Promise.reject("no permission"));
    await loadMatrix();

    button("matrix-copy").click();
    await flush();

    expect(logLines()).toContain("copy failed no permission");
  });

  it("downloads the report and revokes the object URL after the WebKit delay", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:matrix-report");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await loadMatrix();

    vi.useFakeTimers();
    button("matrix-download").click();

    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^rom-weaver-fast-report-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/);
    expect(anchor.getAttribute("href")).toBe("blob:matrix-report");
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:matrix-report");
    vi.useRealTimers();

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("application/json");
    expect(JSON.parse(await blob.text())).toMatchObject({ profile: "fast", status: "idle", version: 1 });
    expect(logLines()).toContain("report downloaded");
  });
});

describe("wake lock", () => {
  it("holds a screen wake lock for the length of a run", async () => {
    const sentinel = createSentinel();
    const request = vi.fn(() => Promise.resolve(sentinel));
    setWakeLock({ request });
    const api = await loadMatrix();

    await api.run("fast");

    expect(request).toHaveBeenCalledWith("screen");
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(logLines()).toContain("wake lock acquired");
    expect(logLines()).toContain("wake lock released");
  });

  it("logs a wake lock the browser refused", async () => {
    setWakeLock({ request: () => Promise.reject(new Error("denied by policy")) });
    const api = await loadMatrix();

    await api.run("fast");

    expect(logLines()).toContain("wake lock failed denied by policy");
    expect(logLines()).not.toContain("wake lock released");
  });

  it("stringifies a non-Error wake lock failure", async () => {
    setWakeLock({ request: () => Promise.reject("no sensor") });
    const api = await loadMatrix();

    await api.run("fast");

    expect(logLines()).toContain("wake lock failed no sensor");
  });

  it("reacquires a wake lock the browser released and drops one that lands after the run", async () => {
    const first = createSentinel();
    const second = createSentinel();
    let grantSecond = () => undefined;
    const secondRequest = new Promise<typeof second>((resolve) => {
      grantSecond = () => resolve(second);
    });
    const request = vi.fn().mockReturnValueOnce(Promise.resolve(first)).mockReturnValueOnce(secondRequest);
    setWakeLock({ request });
    mocks.runBrowserFullFormatMatrix.mockImplementation(() => {
      first.emitRelease();
      return Promise.resolve(createSummary());
    });
    const api = await loadMatrix();

    await api.run("fast");

    expect(request).toHaveBeenCalledTimes(2);
    expect(first.release).not.toHaveBeenCalled();

    grantSecond();
    await flush();

    expect(second.release).toHaveBeenCalledTimes(1);
    expect(logLines().filter((line) => line === "wake lock acquired")).toHaveLength(1);
  });

  it("retries the wake lock when the page becomes visible again mid-run", async () => {
    mocks.runBrowserFullFormatMatrix.mockImplementation(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      return Promise.resolve(createSummary());
    });
    const api = await loadMatrix();

    await api.run("fast");

    expect(logLines().filter((line) => line === "wake lock unavailable; keep this page visible")).toHaveLength(2);
  });
});

describe("interrupted runs", () => {
  it("surfaces an archive stress case the device killed", async () => {
    mocks.getInterruptedArchiveStressCase.mockReturnValue({
      id: "many-entries",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    });

    const api = await loadMatrix();
    const report = api.getReport();

    expect(report).toMatchObject({ profile: "stress", status: "failed" });
    expect(report.result).toMatchObject({ failedSteps: 1, passedSteps: 0 });
    expect(report.result?.durationMs).toBeGreaterThanOrEqual(5000);
    expect(report.steps).toEqual([
      {
        command: "extract",
        error: "The page was reloaded or terminated before the case finished",
        name: "many-entries",
        status: "failed",
        timestamp: expect.any(String),
      },
    ]);
    expect(logLines()).toContain("interrupted archive case detected: many-entries");
    expect(button("matrix-copy").disabled).toBe(false);
  });

  it("surfaces a memory growth run the device killed", async () => {
    mocks.getInterruptedMemoryGrowthRun.mockReturnValue({
      command: "grow 512MiB",
      error: "allocation failed",
      name: "memory-growth",
      status: "failed",
      timestamp: "t",
    });

    const api = await loadMatrix();
    const report = api.getReport();

    expect(report).toMatchObject({ profile: "growth", status: "failed" });
    expect(report.result).toMatchObject({ durationMs: 0, failedSteps: 1, passedSteps: 0 });
    expect(logLines()).toEqual(expect.arrayContaining(["memory-growth grow 512MiB", "allocation failed"]));
  });

  it("keeps a memory growth run that finished before the reload", async () => {
    mocks.getInterruptedMemoryGrowthRun.mockReturnValue({
      command: "grow 256MiB",
      name: "memory-growth",
      status: "succeeded",
      timestamp: "t",
    });

    const api = await loadMatrix();
    const report = api.getReport();

    expect(report).toMatchObject({ profile: "growth", status: "passed" });
    expect(report.result).toMatchObject({ failedSteps: 0, passedSteps: 1 });
    expect(logLines()).toContain("memory-growth grow 256MiB");
  });
});
