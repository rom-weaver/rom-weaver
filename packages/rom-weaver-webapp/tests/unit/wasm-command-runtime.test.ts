import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverIdentifyHashWorker,
  invokeRomWeaverPatchValidateWorker,
} from "../../src/lib/runtime/wasm-command-runtime.ts";

const mocks = vi.hoisted(() => ({ runRomWeaverJson: vi.fn() }));

vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => ({
  runRomWeaverJson: mocks.runRomWeaverJson,
}));

type RunCall = [{ args: Record<string, unknown>; type: string }, Record<string, unknown>];

const succeededResult = (details: unknown, elapsedMs = 250) => ({
  events: [{ details, elapsed_ms: elapsedMs, status: "succeeded" }],
  exitCode: 0,
  ok: true,
  stderr: "",
});

const failedResult = (label: string) => ({
  events: [{ details: {}, label, status: "failed" }],
  exitCode: 2,
  ok: false,
  stderr: "",
});

const lastCall = () => mocks.runRomWeaverJson.mock.calls.at(-1) as RunCall;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invokeRomWeaverExtractWorker", () => {
  const extractDetails = (path = "/out/rom.sfc") => ({
    emitted_files: [{ file_name: "rom.sfc", path, size_bytes: 4096 }],
  });

  it("rejects a request with no input path or no output directory", async () => {
    await expect(invokeRomWeaverExtractWorker({ inputPath: "  ", outDirPath: "/out" })).rejects.toThrow(
      "Extract input path is required",
    );
    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "" })).rejects.toThrow(
      "Extract output directory is required",
    );
  });

  it("dispatches a minimal extract and reports the emitted file", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    const output = await invokeRomWeaverExtractWorker({ inputPath: " /in.zip ", outDirPath: " /out " });

    expect(lastCall()[0]).toEqual({ args: { input: "/in.zip", output: "/out" }, type: "extract" });
    expect(output).toMatchObject({
      fileName: "rom.sfc",
      filePath: "/out/rom.sfc",
      size: 4096,
    });
    expect(output.timing).toEqual({ elapsedMs: 250, elapsedSeconds: 0.25 });
  });

  it("passes the entry filter, the ignore flags, and the thread budget through", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    await invokeRomWeaverExtractWorker({
      inputPath: "/in.zip",
      noIgnore: true,
      noNestedExtract: true,
      outDirPath: "/out",
      select: [" keep.bin ", "", "  ", "other.bin"],
      threads: 4,
    });

    expect(lastCall()[0].args).toMatchObject({
      no_ignore: true,
      no_nested_extract: true,
      select: ["keep.bin", "other.bin"],
      threads: 4,
    });
  });

  it("omits the entry filter when the caller passes something that is not a list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    await invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out", select: undefined });

    expect(lastCall()[0].args).not.toHaveProperty("select");
  });

  it("names the output from the selected entry when the emitted file has no name", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ emitted_files: [{ path: "/out/nested/data.bin" }] }));

    const output = await invokeRomWeaverExtractWorker({
      inputPath: "/in.zip",
      outDirPath: "/out",
      select: ["chosen.bin"],
    });

    expect(output.fileName).toBe("data.bin");
  });

  it("reports a run that emitted no output file", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ emitted_files: [] }));

    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" })).rejects.toThrow(
      "Extraction returned no output file",
    );
  });

  it("reports a failed extraction", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("archive is corrupt"));

    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" })).rejects.toThrow(
      /archive is corrupt|Extraction failed/,
    );
  });

  it("relays progress events to the caller", async () => {
    mocks.runRomWeaverJson.mockImplementation((_command: unknown, options: { onEvent?: (event: unknown) => void }) => {
      options.onEvent?.({ percent: 50, status: "running", step: "extract" });
      return Promise.resolve(succeededResult(extractDetails()));
    });
    const onProgress = vi.fn();

    await invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" }, onProgress);

    expect(onProgress).toHaveBeenCalled();
  });
});

describe("invokeRomWeaverIdentifyHashWorker", () => {
  const identifyDetails = () => ({
    identify: { checksums: { crc32: "abcdef" }, input: "/rom.sfc", matches: [], status: "unknown" },
  });

  it("rejects a request with no hash", async () => {
    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "   " })).rejects.toThrow("Identify hash is required");
  });

  it("lower-cases the hash and forwards the database list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(identifyDetails()));

    await invokeRomWeaverIdentifyHashWorker({ databasePaths: [" /db.dat ", ""], hash: " ABCDEF " });

    expect(lastCall()[0]).toEqual({ args: { database: ["/db.dat"], hash: ["abcdef"] }, type: "identify" });
  });

  it("omits an empty database list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(identifyDetails()));

    await invokeRomWeaverIdentifyHashWorker({ hash: "abc" });

    expect(lastCall()[0].args).not.toHaveProperty("database");
  });

  it("reports a malformed identify payload", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));

    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "abc" })).rejects.toThrow(
      "Identify result was missing or malformed",
    );
  });

  it("reports a failed identify run", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("no database loaded"));

    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "abc" })).rejects.toThrow(
      /no database loaded|Identify failed/,
    );
  });
});

describe("invokeRomWeaverPatchValidateWorker", () => {
  const validateInput = () => ({
    patchFiles: [
      { patchFileName: "a.ips", patchFilePath: "/a.ips", patchFormat: "ips" },
      { patchFileName: "b.ips", patchFilePath: "/b.ips", patchFormat: "ips" },
    ],
    romFileName: "rom.sfc",
    romFilePath: "/rom.sfc",
  });

  it("reads the independent-mode per-patch verdicts", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        patch_validation: {
          per_patch: [
            { format: "ips", index: 0, patch: "/a.ips", status: "passed" },
            { index: 1, message: "checksum mismatch", status: "failed" },
            { index: -1, status: "passed" },
            { index: "not-a-number", status: "passed" },
            null,
            "nope",
          ],
        },
        valid: true,
      }),
    );

    const result = await invokeRomWeaverPatchValidateWorker(validateInput());

    expect(result.perPatch).toEqual([
      { format: "ips", index: 0, patch: "/a.ips", status: "passed" },
      { index: 1, message: "checksum mismatch", status: "failed" },
    ]);
  });

  it("returns no per-patch verdicts for the chained default mode", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_validation: { per_patch: "none" }, valid: true }));

    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();

    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ valid: true }));
    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();
  });
});

describe("invokeRomWeaverCreatePatchCandidatesWorker", () => {
  const candidateInput = () => ({
    modifiedFileName: "new.sfc",
    modifiedFilePath: "/new.sfc",
    originalFileName: "old.sfc",
    originalFilePath: "/old.sfc",
  });

  it("dispatches a plan-only patch-create and returns the format candidates", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_create_plan: { formats: [] } }));

    const candidates = await invokeRomWeaverCreatePatchCandidatesWorker({ ...candidateInput(), threads: 2 });

    expect(lastCall()[0]).toEqual({
      args: { args: { modified: "/new.sfc", original: "/old.sfc", plan: true, threads: 2 }, type: "create" },
      type: "patch",
    });
    expect(candidates).toBeDefined();
  });

  it("omits the thread budget when the caller gives none", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_create_plan: { formats: [] } }));

    await invokeRomWeaverCreatePatchCandidatesWorker(candidateInput());

    expect((lastCall()[0].args as { args: Record<string, unknown> }).args).not.toHaveProperty("threads");
  });

  it("reports a failed candidate plan", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("inputs are identical"));

    await expect(invokeRomWeaverCreatePatchCandidatesWorker(candidateInput())).rejects.toThrow(
      /inputs are identical|Patch create candidate selection failed/,
    );
  });
});
