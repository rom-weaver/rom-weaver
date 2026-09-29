import { describe, expect, it, vi } from "vitest";
import { ChecksumWorkflowController } from "../../src/lib/workflow/checksum-workflow-controller.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const source = { name: "notes.txt", size: 8 };
const result = {
  fileName: "notes.txt",
  checksums: { crc32: "12345678", md5: "a".repeat(32), sha1: "b".repeat(40) },
  size: 8,
};
const setup = () => {
  const run = vi.fn<NonNullable<WorkflowRuntime["checksum"]>["run"]>().mockResolvedValue(result);
  const releaseSources = vi.fn(async () => undefined);
  const controller = new ChecksumWorkflowController({
    checksum: { run },
    workerIo: { releaseSources },
  } as unknown as WorkflowRuntime);
  return { controller, releaseSources, run };
};

describe("ChecksumWorkflowController", () => {
  it("requires a file before calculating", async () => {
    const { controller } = setup();
    await expect(controller.calculate(["sha256"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("accepts a non-ROM file and enables extraction by default", async () => {
    const { controller, run } = setup();
    await controller.setInput(source);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ algorithms: ["crc32", "md5", "sha1"], autoExtract: true, source }),
    );
    expect(controller.getInput()).toMatchObject({
      fileName: "notes.txt",
      files: [{ checksums: result.checksums, size: 8 }],
      status: "ready",
    });
  });

  it("names the extracted member instead of its archive", async () => {
    const { controller, run } = setup();
    run.mockResolvedValue({ ...result, fileName: "b.bin" });
    await controller.setInput({ name: "bundle.zip", size: 100 });
    expect(controller.getInput()).toMatchObject({
      fileName: "b.bin",
      sourceSize: 100,
      files: [{ fileName: "b.bin", size: 8 }],
    });
    await controller.calculate(["sha256"]);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: "bundle.zip" }));
  });

  it("honors initial algorithm choices and disables extraction", async () => {
    const { controller, run } = setup();
    await controller.setInput({ name: "game.zip", size: 8 }, { algorithms: ["sha256"], autoExtract: false });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ algorithms: ["sha256"], autoExtract: false }));
  });

  it("waits for an algorithm when none is selected", async () => {
    const { controller, run } = setup();
    await controller.setInput(source, { algorithms: [] });
    expect(run).not.toHaveBeenCalled();
    await controller.calculate(["crc32"]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps checksums from one resolved archive member together", async () => {
    const { controller, run } = setup();
    await controller.setInput(source);
    run.mockResolvedValue({
      fileName: "notes.txt",
      checksums: { ...result.checksums, sha256: "c".repeat(64) },
      size: 8,
    });
    await controller.calculate(["sha256"]);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ algorithms: ["crc32", "md5", "sha1", "sha256"] }));
    await controller.calculate(["sha256"]);
    expect(run).toHaveBeenCalledTimes(2);
    const snapshot = controller.getInput();
    if (!snapshot?.files[0]) throw new Error("Checksum file is missing");
    snapshot.files[0].checksums.sha256 = "changed";
    expect(controller.getInput()?.files[0]?.checksums.sha256).toBe("c".repeat(64));
  });

  it("keeps the last result and permits retry after cancellation", async () => {
    const { controller, run } = setup();
    await controller.setInput(source);
    run.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" })));
        }),
    );
    const pass = controller.calculate(["blake3"]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pass).rejects.toMatchObject({ code: "CANCELLED" });
    expect(controller.getInput()?.files[0]?.checksums).toEqual(result.checksums);
    run.mockResolvedValue({
      fileName: "notes.txt",
      checksums: { ...result.checksums, blake3: "d".repeat(64) },
      size: 8,
    });
    await expect(controller.calculate(["blake3"])).resolves.toMatchObject({
      files: [{ checksums: { blake3: "d".repeat(64) } }],
    });
  });

  it("releases inputs when replacing and disposing them", async () => {
    const { controller, releaseSources } = setup();
    await controller.setInput(source);
    await controller.setInput({ name: "empty.txt", size: 0 });
    expect(releaseSources).toHaveBeenCalledWith([source]);
    await controller.dispose();
    await controller.dispose();
    expect(releaseSources).toHaveBeenCalledTimes(2);
    expect(controller.getInput()).toBeNull();
  });
});
