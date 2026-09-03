// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  createWorkflowFormError,
  getDefaultCreateOutputName,
  getReactBinarySourceFileName,
  toReactProgressEvent,
  toStagedInputInfo,
} from "../../src/public/react/workflow-adapters.ts";

describe("workflow adapters", () => {
  it("reads names from files and host file handles and derives create names", () => {
    const file = new File(["bytes"], "game.sfc");
    expect(getReactBinarySourceFileName(file, "fallback.bin")).toBe("game.sfc");
    expect(getReactBinarySourceFileName({ name: "host.iso" } as never, "fallback.bin")).toBe("host.iso");
    expect(getReactBinarySourceFileName({} as never, "fallback.bin")).toBe("fallback.bin");
    expect(getReactBinarySourceFileName(null, "fallback.bin")).toBe("");
    expect(getDefaultCreateOutputName(file)).toBe("game");
  });

  it("normalizes progress stages, percentages, and message details", () => {
    expect(
      toReactProgressEvent({
        details: { sourceId: "rom-1" },
        hasProgress: true,
        indeterminate: false,
        label: "Compressing",
        percent: 125.4,
        role: "output",
        stage: "compress",
      }),
    ).toMatchObject({
      details: { role: "output", sourceId: "rom-1", visualPercent: 100 },
      label: "Compressing",
      message: "Compressing 100%",
      percent: 100,
      stage: "output",
    });
    expect(toReactProgressEvent({ hasProgress: false, label: "Reading", percent: null, stage: "input" })).toEqual(
      expect.objectContaining({ hasProgress: false, message: "Reading", stage: "input" }),
    );
    expect(toReactProgressEvent({ indeterminate: true, label: "Applying", stage: "apply" })).toMatchObject({
      indeterminate: true,
      stage: "apply",
    });
  });

  it("projects archive and resolved-input metadata and creates coded errors", () => {
    const source = {
      fileName: "leaf.bin",
      parentCompressions: [
        { depth: 2, fileName: "outer.7z" },
        { depth: 1, fileName: "inner.zip" },
      ],
      size: 20,
      sourceSize: 40,
      decompressionTimeMs: 8,
      checksums: { crc32: "1234abcd" },
    } as never;
    expect(toStagedInputInfo(source, "archive.zip")).toMatchObject({
      archiveName: "inner.zip > outer.7z",
      fileName: "leaf.bin",
      size: 20,
    });

    const resolved = toStagedInputInfo(
      {
        candidates: [{ type: "file", id: "entry", fileName: "folder/game.bin" }],
        fileName: "archive.zip",
        parentCompressions: [],
        resolvedInputs: [
          {
            fileName: "folder/game.bin",
            id: "entry",
            parentCompressions: [],
            selected: true,
            selectedCandidateId: "entry",
            size: 10,
          },
        ],
      } as never,
      "archive.zip",
      { md5: "0123456789abcdef0123456789abcdef" },
    );
    expect(resolved).toMatchObject({
      archiveName: "archive.zip",
      checksums: { md5: "0123456789abcdef0123456789abcdef" },
      fileName: "folder/game.bin",
      size: 10,
    });
    expect(toStagedInputInfo(null, "none")).toBeNull();

    const error = createWorkflowFormError("INVALID_INPUT", "Input required");
    expect(error).toMatchObject({ code: "INVALID_INPUT", message: "Input required" });
  });
});
