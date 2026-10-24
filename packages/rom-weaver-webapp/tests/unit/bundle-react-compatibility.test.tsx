// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toApplyWorkflowSettings } from "../../src/public/react/settings-context.tsx";

const state = vi.hoisted(() => ({ options: undefined as unknown }));
vi.mock("../../src/public/react/weave-export.tsx", () => ({
  useWeaveExport: (options: unknown) => {
    state.options = options;
    return { setFormat: vi.fn(), setWeaveRom: vi.fn() };
  },
  resolveWeaveArchiveFormat: () => "7z",
}));
const { useApplyWeaveExport } = await import("../../src/public/react/use-apply-weave-export.ts");

describe("React bundle compatibility", () => {
  it("retains both common and output bundle settings with canonical precedence", () => {
    expect(toApplyWorkflowSettings({ bundlePackage: "zip:rom" }).output?.weavePackage).toBe("zip:rom");
    expect(toApplyWorkflowSettings({ output: { bundlePackage: "7z:patches" } }).output?.weavePackage).toBe(
      "7z:patches",
    );
    expect(
      toApplyWorkflowSettings({ bundlePackage: "zip:rom", output: { weavePackage: "" } }).output?.weavePackage,
    ).toBe("");
  });

  it("delivers old result fields to bundle callbacks and preserves weave callbacks", () => {
    const onBundleExportComplete = vi.fn();
    const onWeaveExportComplete = vi.fn();
    renderHook(() =>
      useApplyWeaveExport({
        props: { onBundleExportComplete, onWeaveExportComplete },
        preparedWorkflowRef: { current: null },
        workflowHandle: { peek: () => null },
        weaveSourcesRef: { current: null },
        outputState: { compressionFormat: "7z" },
      } as Parameters<typeof useApplyWeaveExport>[0]),
    );
    const created = { weave: { patches: [], version: 2 }, weavePath: "/work/pack.json", warnings: [] };
    act(() => (state.options as { onComplete: (result: typeof created) => void }).onComplete(created));
    expect(onWeaveExportComplete).toHaveBeenCalledWith(created);
    expect(onBundleExportComplete).toHaveBeenCalledWith({
      bundle: created.weave,
      bundlePath: created.weavePath,
      warnings: [],
    });
  });
});
