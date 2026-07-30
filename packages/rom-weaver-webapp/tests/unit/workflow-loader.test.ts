import { describe, expect, it } from "vitest";
import { createWorkflowHandle } from "../../src/public/react/workflow-loader.ts";

/**
 * Single-flight workflow handle: the forms lazy-load the browser API chunk and
 * construct their workflow inside the load promise. A reset that races the load
 * must not publish the late-constructed workflow (that would pin a disposed
 * instance as `current` and wedge every later `get`).
 */

type FakeWorkflow = {
  disposed: boolean;
  dispose: () => Promise<void>;
};

const createFakeWorkflow = (): FakeWorkflow => {
  const workflow: FakeWorkflow = {
    disposed: false,
    dispose: async () => {
      workflow.disposed = true;
    },
  };
  return workflow;
};

const createDeferredLoad = () => {
  let resolve: (create: () => FakeWorkflow) => void = () => undefined;
  const promise = new Promise<() => FakeWorkflow>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { load: () => promise, resolve };
};

describe("createWorkflowHandle", () => {
  it("constructs once and shares the in-flight load across concurrent callers", async () => {
    const handle = createWorkflowHandle<FakeWorkflow>();
    const { load, resolve } = createDeferredLoad();
    let constructed = 0;
    const first = handle.get(load);
    const second = handle.get(() => {
      throw new Error("second caller must reuse the in-flight load");
    });
    resolve(() => {
      constructed += 1;
      return createFakeWorkflow();
    });
    const workflow = await first;
    expect(await second).toBe(workflow);
    expect(constructed).toBe(1);
    expect(handle.peek()).toBe(workflow);
    expect(await handle.get(load)).toBe(workflow);
  });

  it("returns the current workflow from reset for disposal and clears it", async () => {
    const handle = createWorkflowHandle<FakeWorkflow>();
    const workflow = await handle.get(async () => createFakeWorkflow);
    expect(handle.reset()).toBe(workflow);
    expect(handle.peek()).toBeNull();
    expect(handle.reset()).toBeNull();
  });

  it("disposes a workflow whose load lost a race against reset instead of publishing it", async () => {
    const handle = createWorkflowHandle<FakeWorkflow>();
    const { load, resolve } = createDeferredLoad();
    const stalePromise = handle.get(load);
    expect(handle.reset()).toBeNull();
    resolve(createFakeWorkflow);
    const stale = await stalePromise;
    await Promise.resolve();
    expect(stale.disposed).toBe(true);
    expect(handle.peek()).toBeNull();
    const fresh = await handle.get(async () => createFakeWorkflow);
    expect(fresh).not.toBe(stale);
    expect(fresh.disposed).toBe(false);
    expect(handle.peek()).toBe(fresh);
  });

  it("keeps a post-reset load's workflow when the stale load resolves last", async () => {
    const handle = createWorkflowHandle<FakeWorkflow>();
    const staleLoad = createDeferredLoad();
    const stalePromise = handle.get(staleLoad.load);
    handle.reset();
    const freshLoad = createDeferredLoad();
    const freshPromise = handle.get(freshLoad.load);
    freshLoad.resolve(createFakeWorkflow);
    const fresh = await freshPromise;
    staleLoad.resolve(createFakeWorkflow);
    const stale = await stalePromise;
    await Promise.resolve();
    expect(stale).not.toBe(fresh);
    expect(stale.disposed).toBe(true);
    expect(fresh.disposed).toBe(false);
    expect(handle.peek()).toBe(fresh);
  });
});
