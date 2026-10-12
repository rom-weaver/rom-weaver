// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getAgentWorkflow } from "../../../src/webapp/agent/workflow-registry.ts";
import { ChecksumForm } from "../../../src/webapp/components/checksum-form.tsx";

const host = vi.hoisted(() => ({ select: undefined as ((request: string) => Promise<number[]>) | undefined }));
const runtime = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../src/workers/rom-weaver/runner-control.ts", () => ({
  setInputSelectionHandler: (handler: typeof host.select) => {
    host.select = handler;
  },
}));
vi.mock("../../../src/public/react/workflow-loader.ts", async () => {
  const { ChecksumWorkflowController } = await import("../../../src/lib/workflow/checksum-workflow-controller.ts");
  return {
    loadBrowserApi: async () => ({
      ChecksumWorkflow: class extends ChecksumWorkflowController<File> {
        constructor(options: ConstructorParameters<typeof ChecksumWorkflowController>[1]) {
          super(
            { checksum: { run: runtime.run } } as ConstructorParameters<typeof ChecksumWorkflowController>[0],
            options,
          );
        }
      },
    }),
  };
});
const checksums = { crc32: "c6fb1252", md5: "a".repeat(32), sha1: "b".repeat(40) };

describe("ChecksumForm host selection", () => {
  it("removes only the cancelled workflow with duplicate names and concurrent host prompts", async () => {
    runtime.run.mockImplementation(async ({ source }: { source: File }) => {
      const selected = await host.select?.(
        JSON.stringify({
          heading: "extract input payload selection for `/work/dup.zip` is ambiguous",
          candidates: [{ label: "game.bin" }, { label: "other.bin" }],
        }),
      );
      if (!selected?.length)
        throw new Error("validation error: interactive selection was cancelled for `/work/dup.zip`");
      return { checksums, fileName: "game.bin", size: source.size };
    });
    render(<ChecksumForm />);
    fireEvent.change(screen.getByLabelText("Drop a file to checksum it"), {
      target: { files: [new File(["first"], "dup.zip"), new File(["second"], "dup.zip")] },
    });
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    const secondDialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /game.bin/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findAllByText(checksums.crc32);
    await waitFor(() => expect(getAgentWorkflow("checksum")?.getState().sourceStatus).toBe("ready"));
    expect(getAgentWorkflow("checksum")?.getState().source).toMatchObject({ size: 6 });
    expect(screen.queryByText("dup.zip")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(secondDialog).toBeTruthy();
  });

  it("offers retry when one workflow failed and another has every selected checksum", async () => {
    runtime.run.mockImplementation(async ({ source }: { source: File }) => {
      if (source.name === "failed.bin") throw new Error("temporary read failure");
      return { checksums, fileName: source.name, size: source.size };
    });
    render(<ChecksumForm />);
    fireEvent.change(screen.getByLabelText("Drop a file to checksum it"), {
      target: { files: [new File(["a"], "failed.bin"), new File(["b"], "ready.bin")] },
    });
    await screen.findByText(/temporary read failure/);
    await screen.findAllByText(checksums.crc32);
    const retry = await screen.findByRole("button", { name: "Calculate CRC32, MD5, SHA-1" });
    const agent = getAgentWorkflow("checksum");
    expect(agent?.actions.run?.enabled).toBe(true);
    expect(agent?.getState().missingAlgorithms).toEqual(["crc32", "md5", "sha1"]);
    runtime.run.mockImplementation(async ({ source }: { source: File }) => ({
      checksums,
      fileName: source.name,
      size: source.size,
    }));
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(/temporary read failure/)).toBeNull());
    await waitFor(() => expect(screen.getAllByText(checksums.crc32)).toHaveLength(2));
  });
});
