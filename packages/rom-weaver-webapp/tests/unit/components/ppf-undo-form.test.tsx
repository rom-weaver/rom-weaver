// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PpfUndoForm } from "../../../src/webapp/components/ppf-undo-form.tsx";

vi.mock("../../../src/platform/browser/browser-api.ts", () => ({ undoPpf: vi.fn() }));
vi.mock("../../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: {
    ingest: {
      run: vi.fn(async ({ fileName }: { fileName: string }) => ({
        outputs: [],
        patchOutputs: [],
        result:
          fileName === "game.ppf"
            ? { assets: [], patches: [{ fileName, format: "ppf", isValidPatch: true }] }
            : { assets: [{ fileName }], patches: [] },
      })),
    },
  },
}));
vi.mock("../../../src/webapp/compress-service.ts", () => ({ getCompressFormats: async () => ["zip", "7z"] }));

describe("PpfUndoForm", () => {
  it("stages the PPF undo inputs and derives a restored ROM name", async () => {
    const onSessionChange = vi.fn();
    render(<PpfUndoForm onSessionChange={onSessionChange} />);

    // The empty form shows only ghost steps; the workflow steps appear on staging.
    expect(screen.queryByRole("button", { name: "Restore original ROM" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Drop a patched ROM and PPF patch"), {
      target: { files: [new File(["patched"], "game.sfc"), new File(["patch"], "game.ppf")] },
    });

    const run = await screen.findByRole("button", { name: "Restore original ROM" });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("game.sfc")).toBeTruthy();
    expect(screen.getByText("game.ppf")).toBeTruthy();
    expect((screen.getByLabelText("Output filename") as HTMLTextAreaElement).value).toBe("game-restored");
    expect((run as HTMLButtonElement).disabled).toBe(false);
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
  });
});
