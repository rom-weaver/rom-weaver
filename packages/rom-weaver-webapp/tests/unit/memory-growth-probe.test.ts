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
 * Stand in for the engine: grow freely up to `commitCeilingMib`, then refuse.
 *
 * A real class, not `vi.fn()` with an arrow - the latter is not a constructor, so every
 * `new WebAssembly.Memory(...)` would throw and the probe would report a reserve failure instead of
 * measuring growth.
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

/** The unit environment is plain node, which has no localStorage; the probe's durability is the
 * behaviour under test, so it needs a real (in-memory) one rather than the null-storage fallback. */
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
  it("reports the committed ceiling when the engine refuses further growth", async () => {
    setLocation("?growthTargetMib=512&growthStepMib=64");
    stubEngine(192);

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toBe("verdict: device ceiling is 192 MiB of committed shared memory");
    expect(summary.steps.some((step) => step.name === "engine refused further growth")).toBe(true);
  });

  it("reports a clean completion when the engine reaches the target", async () => {
    setLocation("?growthTargetMib=128&growthStepMib=64");
    stubEngine(4096);

    const summary = await runProbe();
    const verdict = summary.steps.at(-1);

    expect(verdict?.name).toBe("verdict: committed the full 128 MiB without refusal");
    expect(summary.failedSteps).toBe(0);
  });

  it("persists progress before each step so a kill leaves the last good value", async () => {
    setLocation("?growthTargetMib=256&growthStepMib=64");
    stubEngine(128);

    await runProbe();

    // The record has to survive the run, not be written only at the end - that is what makes a
    // device kill recoverable.
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.committedMib).toBe(128);
    expect(stored.status).toBe("refused");
  });

  it("surfaces a record left running by a previous load as a device kill", async () => {
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

    // The whole point: the run that killed the tab never got to report, so the next run reports it.
    expect(previous?.name).toBe("previous run: DEVICE DIED mid-probe");
    expect(previous?.error).toContain("768 MiB");
    expect(previous?.status).toBe("failed");
  });

  it("exposes a killed run at page load without needing another run", async () => {
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

    // The bug this covers: reporting only from inside the probe meant a killed run showed nothing on
    // reload, and starting another run to see it wiped the log and risked another kill.
    const step = getInterruptedMemoryGrowthRun();

    expect(step?.name).toBe("previous run: DEVICE DIED mid-probe");
    expect(step?.error).toContain("832 MiB");
  });

  it("keeps a killed run readable across repeated reloads", () => {
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

    // Non-destructive read: the archive-stress equivalent clears on read, which would make the
    // result vanish if the page reloaded twice.
    expect(getInterruptedMemoryGrowthRun()?.error).toContain("512 MiB");
    expect(getInterruptedMemoryGrowthRun()?.error).toContain("512 MiB");
  });

  it("returns nothing at load when no run was interrupted", () => {
    expect(getInterruptedMemoryGrowthRun()).toBeNull();
  });

  it("clamps an absurd step size rather than trusting the query string", async () => {
    setLocation("?growthTargetMib=512&growthStepMib=99999");
    stubEngine(4096);

    const summary = await runProbe();
    const start = summary.steps.find((step) => step.name === "growth probe start");

    // A step larger than the cap could take the device out before the previous value is durable.
    expect(start?.command).toContain("step=128 MiB");
  });
});
