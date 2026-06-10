import { describe, expect, it } from "vitest";
import {
  clampRomWeaverBrowserThreadRequest,
  collectRomWeaverRunInputPaths,
  createRomWeaverCommand,
  getRomWeaverCommandLabel,
  KNOWN_COMMAND_TYPES,
  KNOWN_PATCH_COMMAND_TYPES,
  normalizeRomWeaverRunRequest,
  readRomWeaverRequestedThreadCount,
  withRomWeaverDefaultThreads,
} from "../../src/wasm/rom-weaver-command.ts";

describe("rom-weaver command boundary helpers", () => {
  it("exports Rust-generated known command discriminants", () => {
    expect(KNOWN_COMMAND_TYPES).toEqual(["probe", "list", "extract", "checksum", "compress", "trim", "patch"]);
    expect(KNOWN_PATCH_COMMAND_TYPES).toEqual(["apply", "validate", "create-candidates", "create"]);
  });

  it("builds nested patch commands and preserves patch labels", () => {
    const command = createRomWeaverCommand("patch-apply", {
      input: "/work/original.bin",
      output: "/work/output.bin",
      patches: ["/work/update.bps"],
    });

    expect(command).toEqual({
      args: {
        args: {
          input: "/work/original.bin",
          output: "/work/output.bin",
          patches: ["/work/update.bps"],
        },
        type: "apply",
      },
      type: "patch",
    });
    expect(getRomWeaverCommandLabel(command)).toBe("patch-apply");
  });

  it("normalizes run requests and collects command plus known input paths", () => {
    const request = normalizeRomWeaverRunRequest(
      {
        command: createRomWeaverCommand("patch-apply", {
          input: "/work/original.bin",
          output: "/work/output.bin",
          patches: ["/work/update.bps", "--not-a-path"],
        }),
        output: { trace: true },
      },
      { json: true },
    );

    expect(request.output).toEqual({ json: true, trace: true });
    expect(collectRomWeaverRunInputPaths(request, { knownInputPaths: ["/work/sidecar.bin"] })).toEqual([
      "/work/original.bin",
      "/work/update.bps",
      "/work/sidecar.bin",
    ]);
  });

  it("injects and clamps browser thread defaults only for threaded commands", () => {
    const request = normalizeRomWeaverRunRequest(
      createRomWeaverCommand("compress", {
        input: ["/work/source.bin"],
        output: "/work/archive.zip",
      }),
    );
    const withDefault = withRomWeaverDefaultThreads(request, 12);
    const clamped = clampRomWeaverBrowserThreadRequest(withDefault, {
      autoThreads: 4,
      defaultThreads: 12,
      maxThreads: 8,
    });

    expect(clamped.command.args.threads).toBe(8);
    expect(readRomWeaverRequestedThreadCount(clamped, { maxThreads: 8 })).toBe(8);

    const listRequest = normalizeRomWeaverRunRequest(createRomWeaverCommand("list", { source: "/work/archive.zip" }));
    expect(withRomWeaverDefaultThreads(listRequest, 4)).toBe(listRequest);
  });

  it("rejects malformed command discriminants with known command details", () => {
    expect(() => normalizeRomWeaverRunRequest({ args: {}, type: "convert" })).toThrow(
      /rom-weaver typed command has unsupported `type` field: convert .*known: "probe".*"patch"/,
    );
    expect(() =>
      normalizeRomWeaverRunRequest({
        args: { args: {}, type: "repair" },
        type: "patch",
      }),
    ).toThrow(/rom-weaver patch command has unsupported nested `type` field: repair .*known: "apply".*"create"/);
  });
});
