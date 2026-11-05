import { describe, expect, it } from "vitest";
import { getEngineError, hasEngineErrorCode, RomWeaverError, toRomWeaverError } from "../../src/lib/errors.ts";
import { formatCodedErrorForDisplay } from "../../src/presentation/errors.ts";
import { createLocalizer } from "../../src/presentation/localization/index.ts";
import { isPatchFileChecksumFailure } from "../../src/public/react/patch-validation-failure.ts";
import { ROM_WEAVER_ERROR_CODES } from "../../src/wasm/generated/rom-weaver-format-metadata.ts";
import {
  getRomWeaverFailureCode,
  getRomWeaverFailureMessage,
  withRomWeaverFailure,
} from "../../src/workers/rom-weaver/runner-errors.ts";

type FailedEvent = {
  command?: string;
  error_code?: string;
  error_fields?: Record<string, string | number | boolean>;
  error_kind?: string;
  label?: string;
  status?: string;
};

const failedRun = (event: FailedEvent) =>
  ({ events: [{ command: "patch-apply", label: "failed", status: "failed", ...event }] }) as unknown as Parameters<
    typeof withRomWeaverFailure
  >[1];

const engineFailure = (event: FailedEvent) =>
  withRomWeaverFailure(new Error(event.label ?? "failed"), failedRun(event)) as Error & {
    code?: string;
    details?: Record<string, unknown>;
    kind?: string;
  };

describe("engine error codes", () => {
  it("maps a coded failure through the generated table and keeps its code and fields", () => {
    const error = engineFailure({
      error_code: "wbfs.size_mismatch",
      error_fields: { actual: 10, expected: 20 },
      error_kind: "validation",
      label: "validation failed: checksum of extract archive differs [wbfs.size_mismatch] (actual=10, expected=20)",
    });
    expect(error.code).toBe(ROM_WEAVER_ERROR_CODES["wbfs.size_mismatch"]);
    expect(error.kind).toBe("validation");
    expect(getEngineError(error)).toEqual({ code: "wbfs.size_mismatch", fields: { actual: 10, expected: 20 } });
    // The text mentions "checksum" and "extract"; classification ignores it.
    expect(toRomWeaverError(error).code).toBe("INVALID_INPUT");
  });

  it("drops the CLI tag from a coded failure's message", () => {
    expect(
      engineFailure({
        error_code: "patch.checksum_mismatch",
        label: "Input checksum mismatch for crc32; expected 55c82206, actual b63cfbcd [patch.checksum_mismatch]",
      }).message,
    ).toBe("Input checksum mismatch for crc32; expected 55c82206, actual b63cfbcd");
    expect(
      engineFailure({
        error_code: "extract.max_depth_exceeded",
        label:
          "nested extract exceeded max depth of 8 at `a (1).zip` [extract.max_depth_exceeded] (max_depth=8, path=a (1).zip)",
      }).message,
    ).toBe("nested extract exceeded max depth of 8 at `a (1).zip`");
    // An uncoded failure keeps its text, brackets included.
    expect(engineFailure({ label: "bad entry [see.docs]" }).message).toBe("bad entry [see.docs]");
  });

  it("drops the CLI tag from a coded failure message before context is appended", () => {
    const result = failedRun({
      error_code: "io.storage_full",
      label: "i/o error: No space left on device (os error 51) [io.storage_full]",
    });
    expect(getRomWeaverFailureMessage(result)).toBe("i/o error: No space left on device (os error 51)");
    expect(getRomWeaverFailureMessage(failedRun({ label: "bad entry [see.docs]" }))).toBe("bad entry [see.docs]");
  });

  it("keeps a coded failure's detail field when the CLI tag is dropped", () => {
    const detail = "checksum mismatch for crc32; expected deadbeef, actual 2cccfa33";
    const result = failedRun({
      error_code: "patch.chain.output_mismatch",
      error_fields: { detail, patch_index: 0 },
      label: `validation failed: chain step output does not match the patch's declared output checks [patch.chain.output_mismatch] (detail=${detail}, patch_index=0)`,
    });
    expect(getRomWeaverFailureMessage(result)).toBe(
      `validation failed: chain step output does not match the patch's declared output checks: ${detail}`,
    );
  });

  it("reports engine allocation and storage failures under their own workflow codes", () => {
    expect(engineFailure({ error_code: "resource.out_of_memory", label: "Cannot allocate memory" }).code).toBe(
      "OUT_OF_MEMORY",
    );
    expect(engineFailure({ error_code: "io.storage_full", label: "i/o error: disk is busy" }).code).toBe(
      "STORAGE_FULL",
    );
  });

  it("keeps an engine code's classification even when its text names another failure", () => {
    const error = engineFailure({
      command: "extract",
      error_code: "extract.no_matching_entries",
      label: "validation failed: out of memory, no space left, quota",
    });
    expect(toRomWeaverError(error).code).toBe("COMPRESSION_FAILED");
  });

  it.each([
    ["Cannot enlarge memory arrays", "OUT_OF_MEMORY"],
    ["Wasm OOM while extracting the archive", "OUT_OF_MEMORY"],
    ["No space left on device", "STORAGE_FULL"],
    ["The quota has been exceeded", "STORAGE_FULL"],
    ["QuotaExceededError", "STORAGE_FULL"],
    ["Destination file is not writable", "OUTPUT_WRITE_FAILED"],
    ["Failed to execute 'createWritable' on 'FileSystemFileHandle'", "OUTPUT_WRITE_FAILED"],
  ])("classifies a browser-raised error by its text: %s", (message, code) => {
    expect(toRomWeaverError(new Error(message)).code).toBe(code);
  });

  it("classifies an uncoded failure by its kind and command, not its text", () => {
    expect(engineFailure({ error_kind: "cancelled", label: "checksum" }).code).toBe("CANCELLED");
    expect(engineFailure({ error_kind: "unknown_format" }).code).toBe("UNSUPPORTED_FORMAT");
    expect(engineFailure({ command: "extract", label: "bad header" }).code).toBe("COMPRESSION_FAILED");
    expect(engineFailure({ label: "checksum mismatch in archive" }).code).toBe("INVALID_INPUT");
  });

  it("keeps a workflow code an earlier layer set", () => {
    const error = Object.assign(new Error("full"), { code: "OUTPUT_WRITE_FAILED" });
    withRomWeaverFailure(error, failedRun({ error_code: "archive.read_failed" }));
    expect(error.code).toBe("OUTPUT_WRITE_FAILED");
    expect(hasEngineErrorCode(error, "archive.read_failed")).toBe(true);
  });

  it("finds the engine code through wrapping causes", () => {
    const inner = engineFailure({ error_code: "selection.cancelled" });
    const outer = new RomWeaverError("INVALID_INPUT", "staging failed", { cause: inner });
    expect(hasEngineErrorCode(outer, "selection.cancelled")).toBe(true);
    expect(hasEngineErrorCode(new Error("interactive selection was cancelled"), "selection.cancelled")).toBe(false);
    expect(getRomWeaverFailureCode(failedRun({ error_code: "io.storage_full" }))).toBe("io.storage_full");
    expect(getRomWeaverFailureCode(failedRun({}))).toBeUndefined();
  });

  it("names the archive of a no-ROM extract failure from the code's path field", () => {
    const localizer = createLocalizer();
    const noRom = engineFailure({
      error_code: "extract.no_matching_entries",
      error_fields: { filter: "--filter rom", path: "/work/input/Game (USA).zip" },
    });
    expect(formatCodedErrorForDisplay(noRom, localizer)).toBe("No ROM found in Game (USA).zip.");
    const ignored = engineFailure({ error_code: "extract.all_entries_ignored", error_fields: { path: "/work/a.7z" } });
    expect(formatCodedErrorForDisplay(ignored, localizer)).toMatch(/^No usable ROM found in a\.7z\./);
    const patchOnly = engineFailure({
      error_code: "extract.no_matching_entries",
      error_fields: { filter: "--filter patch", path: "/work/a.zip" },
    });
    expect(formatCodedErrorForDisplay(patchOnly, localizer)).toMatch(/^COMPRESSION_FAILED: /);
  });

  it("reports a damaged patch file from its code", () => {
    const damaged = engineFailure({
      error_code: "patch.file_checksum_invalid",
      label: "Patch checksum invalid; expected: 1, Actual: 2",
    });
    expect(formatCodedErrorForDisplay(damaged, createLocalizer())).toContain(
      "The patch file is damaged (its checksum is invalid).",
    );
    expect(isPatchFileChecksumFailure("patch.file_checksum_invalid")).toBe(true);
    expect(isPatchFileChecksumFailure("patch.checksum_mismatch")).toBe(false);
    expect(isPatchFileChecksumFailure(undefined)).toBe(false);
  });
});
