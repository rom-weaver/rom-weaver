import { describe, expect, it, vi } from "vitest";
import type { ApplyWorkflowInputState } from "../../src/types/apply-workflow.ts";
import {
  createBaseApplyWorkflowSettings,
  createWorkflowOutputOverridesKey,
  createWorkflowPreparationSettingsKey,
  createWorkflowSettingsKey,
  emitApplyWorkflowTrace,
  getApplyOutputCompression,
  getAutomaticApplyOutputName,
  getOutputSourceKey,
  getWorkflowReadinessError,
  isReactBinarySource,
  normalizeApplyResult,
  toPatchStageInfo,
  toStagedInputInfos,
} from "../../src/public/react/apply-workflow-staging-model.ts";

describe("apply workflow staging model", () => {
  it("reports a disc's combined raw-file checksum time on every grouped row", () => {
    const input: ApplyWorkflowInputState = {
      candidates: [],
      id: "disc",
      parentCompressions: [],
      resolvedInputs: [
        {
          checksumTimeMs: 136,
          fileName: "track-1.bin",
          groupId: "disc",
          id: "track-1",
          parentCompressions: [],
          selected: true,
        },
        {
          checksumTimeMs: 155,
          fileName: "track-2.bin",
          groupId: "disc",
          id: "track-2",
          parentCompressions: [],
          selected: true,
        },
      ],
      status: "ready",
      warnings: [],
    };

    expect(toStagedInputInfos(input, []).map((row) => row.checksumTiming)).toEqual(["291ms", "291ms"]);
  });

  it("shows the identified ROM title on the staged input row", () => {
    const input: ApplyWorkflowInputState = {
      candidates: [],
      id: "rom",
      identification: {
        matches: [
          {
            algorithm: "sha1",
            database: "gba.rwfp1",
            name: "Advance Wars (USA)",
            alternateNames: ["Advance Wars (U) [!]"],
            platform: "Game Boy Advance",
            variant: "raw",
          },
        ],
        status: "matched",
      },
      parentCompressions: [],
      status: "ready",
      warnings: [],
    };

    expect(toStagedInputInfos(input, [])[0]?.identificationStatus).toBe("matched");
    expect(toStagedInputInfos(input, [])[0]?.romInfo).toBe("Advance Wars (USA)");
  });

  it("shows an expected ROM title in patch validation details", () => {
    const info = toPatchStageInfo(
      {
        candidates: [],
        id: "patch",
        parentCompressions: [],
        requirements: { sourceTitles: ["Advance Wars (USA)"] },
        status: "ready",
        warnings: [],
      },
      "hack.bps",
      0,
      "Input 1",
    );

    expect(info?.validationValues).toContain("in rom=Advance Wars (USA)");
    expect(info?.validationState).toBe("unknown");
  });

  it("derives output identity and settings keys from the current sources", () => {
    const input = new File(["rom"], "game.iso");
    const patch = new File(["patch"], "hack[final].ips");
    const snapshot = {
      inputs: [input],
      patches: [patch],
      options: { input: { containerInputsEnabled: true }, output: { compression: "auto", outputName: "" } },
    } as never;

    expect(getOutputSourceKey([input], [patch])).toContain("game.iso");
    expect(getAutomaticApplyOutputName(snapshot, null, [])).toBe("game");
    expect(
      getAutomaticApplyOutputName(snapshot, { fileName: "resolved.bin" } as never, [
        { fileName: "hack[final].ips" } as never,
      ]),
    ).toContain("resolved");
    expect(getApplyOutputCompression({ ...snapshot, options: { output: { compression: "7z" } } }, null)).toBe("7z");
    expect(createWorkflowOutputOverridesKey(snapshot)).toContain('"compression":"auto"');
    expect(createWorkflowSettingsKey({ workers: { threads: 3 } })).toContain('"threads":3');
    expect(createWorkflowPreparationSettingsKey({ workers: { threads: 3 }, input: {} } as never)).toContain("threads");
    expect(
      createBaseApplyWorkflowSettings(
        {
          input: { containerInputsEnabled: false },
          output: { compression: "zip", outputName: "named" },
          workers: { threads: 2 },
        } as never,
        4,
      ),
    ).toMatchObject({ output: { compression: undefined, outputName: undefined } });
  });

  it("projects selected archive entries and all patch validation choices", () => {
    const patch = {
      candidates: [
        {
          type: "file",
          id: "selected",
          fileName: "folder/hack.ips",
          kind: "patch",
          selectable: true,
        },
      ],
      checksumPreflight: { status: "valid" },
      checksumTimeMs: 13,
      headerChoice: "strip",
      headerResolution: { decided: true, mode: "strip", strippedBytes: 512 },
      id: "patch-1",
      n64ByteOrderChoice: "big-endian",
      n64Resolution: { decided: true, mode: "big-endian", sourceOrder: "little-endian" },
      parentCompressions: [
        { depth: 2, fileName: "outer.7z" },
        { depth: 1, fileName: "inner.zip" },
      ],
      requirements: {
        format: "IPS",
        minimumSourceSize: 100,
        sourceCrc32: "1234abcd",
        sourceSize: 2048,
        sourceTitles: ["Advance Wars (USA)"],
        targetCrc32: "deadbeef",
        targetSize: 4096,
      },
      selectedCandidateId: "selected",
      size: 80,
      sourceSize: 20,
      status: "ready",
      targetInputId: "rom-1",
      targetInputFileName: "game.bin",
      warnings: [],
      wasDecompressed: true,
    } as never;
    const info = toPatchStageInfo(patch, "archive.zip", 2, "Target: game.bin");

    expect(info).toMatchObject({
      archiveName: "inner.zip > outer.7z",
      basisChoice: undefined,
      fileName: "folder/hack.ips",
      format: "IPS",
      headerAutoMode: "strip",
      headerChoice: "strip",
      n64AutoMode: "big-endian",
      n64ByteOrderChoice: "big-endian",
      showHeaderOption: true,
      showN64ByteOrderOption: true,
      targetInputFileName: "game.bin",
      validationState: "verifying",
    });
    expect(info?.validationValues).toEqual([
      "in rom=Advance Wars (USA)",
      "in size=2048",
      "in min size=100",
      "in crc32=1234abcd",
      "out size=4096",
      "out crc32=deadbeef",
    ]);
  });

  it("reports readiness failures and normalizes a browser result", () => {
    const readyInput = { id: "rom", selectedCandidateId: "rom", status: "ready" } as never;
    const readyPatch = { fileName: "hack.ips", status: "ready" } as never;
    expect(getWorkflowReadinessError(null, [])).toMatchObject({ code: "INVALID_INPUT" });
    expect(getWorkflowReadinessError({ ...readyInput, status: "needsSelection" }, [])).toMatchObject({
      code: "AMBIGUOUS_SELECTION",
    });
    expect(
      getWorkflowReadinessError(readyInput, [
        {
          ...readyPatch,
          status: "needsSelection",
          selectedCandidateId: "pick",
          warnings: [{ code: "PATCH_TARGET_MISMATCH", message: "Pick another target" }],
        },
      ] as never),
    ).toMatchObject({ code: "PATCH_TARGET_MISMATCH", message: "Pick another target" });
    expect(getWorkflowReadinessError(readyInput, [{ ...readyPatch, status: "loading" }] as never)).toMatchObject({
      code: "AMBIGUOUS_SELECTION",
    });
    expect(getWorkflowReadinessError(readyInput, [readyPatch])).toBeNull();

    const dispose = () => undefined;
    const browserOutput = {
      dispose,
      fileName: "out.bin",
      getBlob: async () => new Blob(["output"]),
      id: "output-id",
      prepareDownload: async () => undefined,
      saveAs: async () => undefined,
      size: 6,
    };
    const normalized = normalizeApplyResult({
      inputs: [{ fileName: "game.bin", size: 10 }],
      outputs: [browserOutput],
      patches: [],
      sizeSummary: { outputSize: 6 },
    } as never);
    expect(normalized.output).toMatchObject({ fileName: "out.bin", id: "output-id", size: 6 });
    expect(normalized.outputs[0]?.dispose).toBe(dispose);
    expect(normalized.rom).toEqual({ fileName: "game.bin", size: 10 });
  });

  it("recognizes browser sources and emits trace records only at trace level", () => {
    const file = new File(["rom"], "game.bin");
    expect(isReactBinarySource(file)).toBe(true);
    expect(isReactBinarySource({ kind: "file", getFile: () => file })).toBe(true);
    expect(isReactBinarySource({ kind: "file" })).toBe(false);
    expect(isReactBinarySource(null)).toBe(false);

    const sink = vi.fn();
    const options = { logging: { level: "trace", sink } } as never;
    emitApplyWorkflowTrace(options, "staged", { count: 1 });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ level: "trace", message: "staged", namespace: "react:apply-workflow" }),
    );
    emitApplyWorkflowTrace({ logging: { level: "info", sink } } as never, "ignored");
    expect(sink).toHaveBeenCalledOnce();
  });
});
