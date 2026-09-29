import { describe, expect, it, vi } from "vitest";

import { ChecksumWorkflowController } from "../../src/lib/workflow/checksum-workflow-controller.ts";

// Drives the controller through its private staging surface with a fake
// `ingest` runtime, as trim-workflow-controller.test.ts does - no real wasm.

const file = (fileName: string, extras: Record<string, unknown> = {}) => ({
  _sourceRef: { fileName, size: 8, source: `/work/${fileName}` },
  fileName,
  fileSize: 8,
  ...extras,
});

const asset = (id: string, kind: "cue" | "rom" | "track", extras: Record<string, unknown> = {}) => ({
  file: file(`${id}.bin`),
  fileName: `${id}.bin`,
  id,
  kind,
  patchable: kind === "rom",
  size: 8,
  ...extras,
});

const stage = (status: "needsSelection" | "ready", assets: unknown[] = []) => ({
  parentCompressions: [],
  preparedInputAssets: assets,
  source: { name: "game.zip" },
  state: {
    candidates: [],
    fileName: "game.zip",
    id: "input-1",
    parentCompressions: [],
    role: "input" as const,
    status,
    warnings: [],
    ...(status === "ready" ? { selectedCandidateId: "a" } : {}),
  },
});

const ingestResult = (checksums: Record<string, string>, extras: Record<string, unknown> = {}) => ({
  result: { assets: [{ checksums, isRom: true, ...extras }], isRom: true },
});

type Exposed = ChecksumWorkflowController<unknown> & {
  hashAssets: (stage: unknown, algorithms: readonly string[] | undefined) => Promise<void>;
  inputStage?: ReturnType<typeof stage>;
  inputStages: { releaseSession: (session?: unknown) => Promise<void> };
};

const createController = (run: (input: Record<string, unknown>) => Promise<unknown>) =>
  new ChecksumWorkflowController<unknown>({ ingest: { run } } as never, {}) as unknown as Exposed;

describe("ChecksumWorkflowController.calculate validation", () => {
  it("throws INVALID_INPUT when no ROM has been staged", async () => {
    const controller = createController(vi.fn());
    await expect(controller.calculate(["sha256"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws AMBIGUOUS_SELECTION while the staged input needs a selection", async () => {
    const controller = createController(vi.fn());
    controller.inputStage = stage("needsSelection");
    await expect(controller.calculate(["sha256"])).rejects.toMatchObject({ code: "AMBIGUOUS_SELECTION" });
  });
});

describe("ChecksumWorkflowController staging pass", () => {
  it("reuses digests that extraction already computed", async () => {
    const run = vi.fn();
    const controller = createController(run);
    const rom = asset("rom", "rom", {
      file: file("rom.bin", {
        checksums: { crc32: "a1b2c3d4", md5: "m".repeat(32), sha1: "s".repeat(40) },
        identification: { matches: [], status: "unknown" },
      }),
    });
    controller.inputStage = stage("ready", [rom]);

    await controller.hashAssets(controller.inputStage, undefined);

    expect(run).not.toHaveBeenCalled();
    expect(controller.getInput()).toMatchObject({
      files: [{ checksums: { crc32: "a1b2c3d4" }, fileName: "rom.bin" }],
      identification: { status: "unknown" },
    });
  });

  it("hashes the standard set with identification when nothing was precomputed", async () => {
    const run = vi.fn(async () =>
      ingestResult(
        { crc32: "D4C3B2A1", md5: "M".repeat(32), sha1: "S".repeat(40) },
        { identification: { matches: [], status: "unknown" } },
      ),
    );
    const controller = createController(run);
    controller.inputStage = stage("ready", [asset("rom", "rom")]);

    await controller.hashAssets(controller.inputStage, undefined);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ checksumAlgorithms: ["crc32", "md5", "sha1"] }));
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("identify", false);
    expect(controller.getInput()?.files[0]?.checksums).toEqual({
      crc32: "d4c3b2a1",
      md5: "m".repeat(32),
      sha1: "s".repeat(40),
    });
  });
});

describe("ChecksumWorkflowController.calculate", () => {
  it("hashes only the missing algorithms, skips identify, and merges variants", async () => {
    const run = vi.fn(async () =>
      ingestResult(
        { sha256: "A".repeat(64) },
        { checksumVariants: [{ checksums: { sha256: "b".repeat(64) }, id: "remove-header", label: "Headerless" }] },
      ),
    );
    const controller = createController(run);
    const rom = asset("rom", "rom", {
      checksums: { crc32: "11111111", md5: "m".repeat(32), sha1: "s".repeat(40) },
      checksumVariants: [{ checksums: { crc32: "22222222" }, id: "remove-header", label: "Headerless" }],
    });
    controller.inputStage = stage("ready", [rom]);

    const input = await controller.calculate(["crc32", "sha256"]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ checksumAlgorithms: ["sha256"], identify: false }));
    expect(input.files[0]?.checksums).toMatchObject({ crc32: "11111111", sha256: "a".repeat(64) });
    expect(input.files[0]?.checksumVariants).toEqual([
      { checksums: { crc32: "22222222", sha256: "b".repeat(64) }, id: "remove-header", label: "Headerless" },
    ]);
  });

  it("lists every hashed track, primary first, and skips the cue sheet", async () => {
    const run = vi.fn(async () => ingestResult({ crc16: "abcd" }));
    const controller = createController(run);
    controller.inputStage = stage("ready", [
      asset("disc", "cue"),
      asset("track02", "track", { trackNumber: 2 }),
      asset("track01", "rom", { trackNumber: 1 }),
    ]);

    const input = await controller.calculate(["crc16"]);

    expect(input.files.map((entry) => entry.fileName)).toEqual(["track01.bin", "track02.bin"]);
    expect(input.files[1]).toMatchObject({ checksums: { crc16: "abcd" }, trackNumber: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stays usable after an aborted pass", async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(
      (input: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          const signal = input.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" })));
          release = () => resolve(ingestResult({ blake3: "c".repeat(64) }));
        }),
    );
    const controller = createController(run);
    controller.inputStage = stage("ready", [asset("rom", "rom", { checksums: { crc32: "1", md5: "2", sha1: "3" } })]);

    const aborted = controller.calculate(["blake3"]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "CANCELLED" });

    const retried = controller.calculate(["blake3"]);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    release?.();
    await expect(retried).resolves.toMatchObject({ files: [{ checksums: { blake3: "c".repeat(64) } }] });
  });
});

describe("ChecksumWorkflowController.dispose", () => {
  it("releases the staged input once", async () => {
    const controller = createController(vi.fn());
    const releaseSession = vi.fn(async () => undefined);
    controller.inputStages.releaseSession = releaseSession;
    controller.inputStage = stage("needsSelection");

    await controller.dispose();
    await controller.dispose();

    expect(releaseSession).toHaveBeenCalledTimes(1);
    expect(controller.getInput()).toBeNull();
  });
});
