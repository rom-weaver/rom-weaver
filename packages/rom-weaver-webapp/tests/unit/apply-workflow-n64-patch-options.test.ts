import { describe, expect, it } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type PatchOptions = { n64ByteOrder?: string; resolvedN64ByteOrder?: string };

// The controller assembled just enough to read one patch's options back out.
const patchOptionsFor = (state: Record<string, unknown>): PatchOptions => {
  const controller = new ApplyWorkflowController<unknown, unknown>({ workerIo: {} } as never, {}) as never as {
    createExecutionOptions: unknown;
    createPatchInput: () => { patchOptions: PatchOptions[] };
    getEffectiveInputSources: unknown;
    getPreparedInputAssets: unknown;
    patches: unknown[];
  };
  controller.getEffectiveInputSources = () => [];
  controller.createExecutionOptions = () => ({});
  controller.getPreparedInputAssets = () => [];
  controller.patches = [{ state }];
  return controller.createPatchInput().patchOptions[0] as PatchOptions;
};

/**
 * `resolvedN64ByteOrder` is what stops the engine inferring the order itself, so
 * it may only carry an order a checksum actually proved. An undecided
 * resolution reports `mode: "keep"`, and forwarding that would pin every
 * checksumless patch to the untouched bytes.
 */
describe("ApplyWorkflowController patch options: N64 byte order", () => {
  it("forwards a checksum-proven order", () => {
    expect(patchOptionsFor({ n64Resolution: { decided: true, mode: "byte-swapped" } }).resolvedN64ByteOrder).toBe(
      "byte-swapped",
    );
  });

  it("drops an undecided resolution so the engine infers the order", () => {
    expect(patchOptionsFor({ n64Resolution: { decided: false, mode: "keep" } }).resolvedN64ByteOrder).toBeUndefined();
  });

  it("still forwards the user's own choice", () => {
    const options = patchOptionsFor({
      n64ByteOrderChoice: "little-endian",
      n64Resolution: { decided: false, mode: "keep" },
    });
    expect(options.n64ByteOrder).toBe("little-endian");
    expect(options.resolvedN64ByteOrder).toBeUndefined();
  });
});
