import { describe, expect, it } from "vitest";
import { RomWeaverError } from "../../src/lib/errors.ts";
import { assertDescentOutputLimits } from "../../src/lib/input/input-archive-limits.ts";
import type { ApplyWorkflowOptions } from "../../src/types/workflow-runtime-types.ts";
import type { ExtractedFileEntry } from "../../src/wasm/index.ts";

// Contract test for the typed extract-step output consumer. The Rust producer (`ExtractedFileEntry`
// in crates/rom-weaver-app/src/extract_progress.rs) emits each entry as `{ file_name, size_bytes,
// kind? }` with snake_case keys and JSON-number sizes; this asserts that representative wire payload
// reads correctly through the generated type so the archive limit checks size/name the right fields.
const optionsWithLimits = (limits: NonNullable<ApplyWorkflowOptions>["limits"]): ApplyWorkflowOptions =>
  ({ limits }) as ApplyWorkflowOptions;

// The wire payload is plain JSON: `size_bytes` arrives as a number even though ts-rs types the Rust
// `u64` as `bigint`. Cast through the generated type to prove field access lines up.
const wireOutputs = (entries: Array<{ file_name: string; size_bytes: number | null; kind?: string }>) =>
  entries as unknown as ExtractedFileEntry[];

describe("assertDescentOutputLimits", () => {
  it("passes representative extract-step outputs that are within the configured limits", () => {
    const outputs = wireOutputs([
      { file_name: "leaf.bin", kind: "rom", size_bytes: 1024 },
      { file_name: "readme.txt", kind: "other", size_bytes: 16 },
    ]);
    expect(() =>
      assertDescentOutputLimits(
        optionsWithLimits({ maxArchiveDepth: 8, maxSingleFileBytes: 4096, maxTotalUncompressedBytes: 8192 }),
        0,
        outputs,
        1040,
      ),
    ).not.toThrow();
  });

  it("rejects a single entry that exceeds the per-file byte limit, naming it from file_name", () => {
    const outputs = wireOutputs([{ file_name: "too-big.iso", kind: "rom", size_bytes: 9000 }]);
    let thrown: unknown;
    try {
      assertDescentOutputLimits(optionsWithLimits({ maxSingleFileBytes: 4096 }), 0, outputs, 9000);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RomWeaverError);
    const details = (thrown as RomWeaverError).details as Record<string, unknown> | undefined;
    expect(details?.code).toBe("ARCHIVE_SINGLE_FILE_LIMIT_EXCEEDED");
    expect(details?.entryName).toBe("too-big.iso");
    expect(details?.actual).toBe(9000);
  });

  it("rejects when the accumulated total exceeds the uncompressed limit", () => {
    const outputs = wireOutputs([{ file_name: "leaf.bin", size_bytes: 1024 }]);
    expect(() =>
      assertDescentOutputLimits(optionsWithLimits({ maxTotalUncompressedBytes: 2048 }), 0, outputs, 4096),
    ).toThrow(RomWeaverError);
  });

  it("treats a null size_bytes as zero (libarchive entries report no size)", () => {
    const outputs = wireOutputs([{ file_name: "inner.zip", size_bytes: null }]);
    expect(() => assertDescentOutputLimits(optionsWithLimits({ maxSingleFileBytes: 1 }), 0, outputs, 0)).not.toThrow();
  });
});
