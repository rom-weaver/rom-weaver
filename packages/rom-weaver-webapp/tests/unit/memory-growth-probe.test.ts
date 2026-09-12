import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInterruptedMemoryGrowthRun,
  runBrowserMemoryGrowthProbe,
} from "../../src/wasm/browser-memory-growth-probe.ts";

const MIB = 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;
const PAGES_PER_MIB = MIB / WASM_PAGE_BYTES;
const STORAGE_KEY = "rom-weaver.memory-growth-probe";

const originalMemory = globalThis.WebAssembly.Memory;

/**
 * Provide a constructible memory double that accepts growth up to commitCeilingMib, then refuses it.
 */
const stubEngine = (commitCeilingMib: number) => {
  globalThis.WebAssembly.Memory = class {
    #pages = 0;
    buffer: ArrayBufferLike;
    constructor(descriptor: WebAssembly.MemoryDescriptor) {
      this.#pages = descriptor.initial;
      this.buffer = new ArrayBuffer(this.#pages * WASM_PAGE_BYTES);
    }
    grow(delta: number) {
      const next = this.#pages + delta;
      if (next > commitCeilingMib * PAGES_PER_MIB) throw new RangeError("out of memory");
      this.#pages = next;
      // Engines hand back a new buffer object for the enlarged memory.
      this.buffer = new ArrayBuffer(next * WASM_PAGE_BYTES);
      return next - delta;
    }
  } as unknown as typeof WebAssembly.Memory;
};

const setLocation = (search: string) => {
  vi.stubGlobal("location", { search });
};

/**
 * Use an in-memory Storage implementation to check saved records independently of the test environment.
 */
const createMemoryStorage = () => {
  const entries = new Map<string, string>();
  return {
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  } as unknown as Storage;
};

let storage: Storage;

beforeEach(() => {
  setLocation("");
  vi.stubGlobal("navigator", { userAgent: "probe-test" });
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  globalThis.WebAssembly.Memory = originalMemory;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runProbe = () => runBrowserMemoryGrowthProbe({ onStep: () => undefined });

describe("runBrowserMemoryGrowthProbe", () => {
  it("reports completed growth when the engine refuses the next step", async () => {
    setLocation("?growthTargetMib=512&growthStepMib=64");
    stubEngine(192);

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toBe("result: growth stopped after 192 MiB in this run");
    expect(summary.steps.some((step) => step.name === "engine refused further growth")).toBe(true);
  });

  it("reports a clean completion when the engine reaches the target", async () => {
    setLocation("?growthTargetMib=128&growthStepMib=64");
    stubEngine(4096);

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toBe("result: reached 128 MiB and touched each WASM page");
    expect(summary.failedSteps).toBe(0);
  });

  it("saves the last completed step when further growth is refused", async () => {
    setLocation("?growthTargetMib=256&growthStepMib=64");
    stubEngine(128);

    await runProbe();

    // The saved record includes the last completed step and the refused status.
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.committedMib).toBe(128);
    expect(stored.status).toBe("refused");
  });

  it("surfaces a record left running by a previous load as interrupted", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        committedMib: 768,
        startedAt: "2026-07-28T20:00:00.000Z",
        status: "running",
        stepMib: 32,
        targetMib: 2048,
        userAgent: "previous",
      }),
    );
    setLocation("?growthTargetMib=64&growthStepMib=64");
    stubEngine(4096);

    const summary = await runProbe();
    const previous = summary.steps[0];

    // A saved running record is reported as interrupted when another run starts.
    expect(previous?.name).toBe("previous run: interrupted before completion");
    expect(previous?.error).toContain("768 MiB");
    expect(previous?.status).toBe("failed");
  });

  it("exposes an interrupted run at page load without another allocation", async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        committedMib: 832,
        startedAt: "2026-07-28T20:00:00.000Z",
        status: "running",
        stepMib: 32,
        targetMib: 2048,
        userAgent: "previous",
      }),
    );

    // Reading the prior result MUST NOT require another allocation run.
    const step = getInterruptedMemoryGrowthRun();

    expect(step?.name).toBe("previous run: interrupted before completion");
    expect(step?.error).toContain("832 MiB");
  });

  it("keeps an interrupted run readable across repeated reloads", () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        committedMib: 512,
        startedAt: "2026-07-28T20:00:00.000Z",
        status: "running",
        stepMib: 32,
        targetMib: 2048,
        userAgent: "previous",
      }),
    );

    // Repeated reads MUST preserve the saved result.
    expect(getInterruptedMemoryGrowthRun()?.error).toContain("512 MiB");
    expect(getInterruptedMemoryGrowthRun()?.error).toContain("512 MiB");
  });

  it("returns nothing at load when no record exists", () => {
    expect(getInterruptedMemoryGrowthRun()).toBeNull();
  });

  it("clamps an absurd step size rather than trusting the query string", async () => {
    setLocation("?growthTargetMib=512&growthStepMib=99999");
    stubEngine(4096);

    const summary = await runProbe();
    const start = summary.steps.find((step) => step.name === "growth probe start");

    // Query parameters cannot bypass the maximum step size.
    expect(start?.command).toContain("step=128 MiB");
  });
});
