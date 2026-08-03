import { describe, expect, it } from "vitest";

import { BaseWorkflowController, type BaseWorkflowSnapshot } from "../../src/lib/workflow/base-workflow-controller.ts";
import type { WorkflowOptions } from "../../src/types/workflow-controller.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

// BaseWorkflowController is abstract; a minimal concrete subclass exercises the shared
// lifecycle (queueing, abort/dispose, snapshot caching, progress) that create/trim/apply all
// inherit, mirroring how the apply-controller tests drive their subject through a runtime cast.
class TestWorkflowController extends BaseWorkflowController<unknown, never, BaseWorkflowSnapshot & { calls: number }> {
  calls = 0;

  constructor(runtime: WorkflowRuntime = {} as never, options: WorkflowOptions<never> = {}) {
    super("apply", runtime, options);
  }

  protected computeSnapshot(): BaseWorkflowSnapshot & { calls: number } {
    return { busy: this.isBusy(), calls: ++this.calls, id: this.id, ready: true };
  }

  runQueued<T>(operation: string, callback: () => Promise<T>, opts?: { rearmAbort?: boolean; wrapErrors?: boolean }) {
    return this.runQueuedMutation(operation, callback, opts);
  }

  runExclusive<T>(operation: string, callback: () => Promise<T>) {
    return this.runExclusiveMutation(operation, callback);
  }

  triggerChange(): void {
    this.emitChange();
  }

  async disposeController(): Promise<void> {
    this.abort();
    await this.settleMutations();
    this.clearListeners();
    this.disposed = true;
  }

  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }
}

describe("BaseWorkflowController snapshot caching", () => {
  it("returns the same cached snapshot object until a change fires", () => {
    const controller = new TestWorkflowController();
    const first = controller.getSnapshot();
    const second = controller.getSnapshot();
    expect(second).toBe(first);

    controller.triggerChange();
    const third = controller.getSnapshot();
    expect(third).not.toBe(first);
  });

  it("notifies subscribers on change and lets them unsubscribe", () => {
    const controller = new TestWorkflowController();
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    controller.triggerChange();
    expect(notifications).toBe(1);

    unsubscribe();
    controller.triggerChange();
    expect(notifications).toBe(1);
  });
});

describe("BaseWorkflowController.runQueuedMutation", () => {
  it("serializes queued mutations in call order", async () => {
    const controller = new TestWorkflowController();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = controller.runQueued("first", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = controller.runQueued("second", async () => {
      order.push("second-start");
    });

    expect(controller.getSnapshot().busy).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it("wraps a thrown non-RomWeaverError when wrapErrors is set", async () => {
    const controller = new TestWorkflowController();
    await expect(
      controller.runQueued(
        "boom",
        async () => {
          throw new Error("plain failure");
        },
        { wrapErrors: true },
      ),
    ).rejects.toMatchObject({ message: "plain failure" });
  });

  it("propagates a callback error without wrapping when wrapErrors is unset", async () => {
    const controller = new TestWorkflowController();
    const original = new Error("raw failure");
    await expect(
      controller.runQueued("boom", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("rejects a mutation started after dispose with WORKFLOW_DISPOSED", async () => {
    const controller = new TestWorkflowController();
    await controller.disposeController();
    await expect(controller.runQueued("late", async () => undefined)).rejects.toMatchObject({
      code: "WORKFLOW_DISPOSED",
    });
  });

  it("rejects a mutation when the constructor signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("stop"));
    const controller = new TestWorkflowController({} as never, { signal: abortController.signal });
    await expect(controller.runQueued("op", async () => undefined)).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("BaseWorkflowController.runExclusiveMutation", () => {
  it("rejects a concurrent call with WORKFLOW_BUSY, naming the active operation", async () => {
    const controller = new TestWorkflowController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = controller.runExclusive("scan", async () => {
      await gate;
    });
    await expect(controller.runExclusive("scan-again", async () => undefined)).rejects.toMatchObject({
      code: "WORKFLOW_BUSY",
      details: { activeOperation: "scan", operation: "scan-again" },
    });

    release();
    await first;
  });

  it("allows a new exclusive mutation once the previous one settles", async () => {
    const controller = new TestWorkflowController();
    await controller.runExclusive("first", async () => undefined);
    await expect(controller.runExclusive("second", async () => undefined)).resolves.toBeUndefined();
  });
});

describe("BaseWorkflowController.abort and dispose", () => {
  it("abort() is idempotent and only fires the abort signal once", () => {
    const controller = new TestWorkflowController();
    let aborts = 0;
    controller.abortSignal.addEventListener("abort", () => {
      aborts += 1;
    });
    controller.abort(new Error("first"));
    controller.abort(new Error("second"));
    expect(aborts).toBe(1);
    expect(controller.abortSignal.aborted).toBe(true);
  });

  it("dispose settles queued mutations before returning", async () => {
    const controller = new TestWorkflowController();
    let ran = false;
    const pending = controller.runQueued("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      ran = true;
    });

    await controller.disposeController();

    expect(ran).toBe(true);
    await pending;
  });
});
