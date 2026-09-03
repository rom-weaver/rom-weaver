import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sidecarWorker = vi.hoisted(() => ({ runRomWeaverIngestSidecarsWorker: vi.fn() }));

vi.mock("../../src/lib/runtime/wasm-command-runtime.ts", () => sidecarWorker);

import { getPatchFileCleanup } from "../../src/lib/input/binary-service.ts";
import { readDataTransferFiles } from "../../src/lib/input/dropped-files.ts";
import {
  ensureValidatedPatchArchiveEntryCleanup,
  getValidatedPatchArchiveEntryCache,
} from "../../src/lib/input/input-archive-patch-validity.ts";
import {
  applySidecarPatchOutputLabel,
  getSidecarPatchOutputLabel,
  resolveSidecarPatchEntries,
} from "../../src/lib/input/sidecar-patch-resolution.ts";
import {
  getCreatePatchFormatsForSizes,
  getPreferredCreatePatchFormat,
  normalizeCreatePatchFormat,
} from "../../src/lib/create/patch-format-limits.ts";
import {
  assertBrowserBinarySource,
  getArchiveEntryArrayBuffer,
  getArchiveEntryUint8Array,
  toWorkerMetadata,
} from "../../src/lib/runtime/source-normalization.ts";
import { emitRuntimeTrace, isTraceEnabled, toRomWeaverOptions } from "../../src/lib/runtime/run-options.ts";
import { buildPatchedOutputBaseName, createPatchMetadataLabel } from "../../src/lib/output/output-name-composition.ts";
import {
  getWorkflowSourceFileName,
  roundElapsedMs,
  shouldPrepareWorkflowSource,
} from "../../src/lib/workflow/source-preparation.ts";
import { createWorkflowTracer, traceWorkflowControllerEvent } from "../../src/lib/workflow/workflow-tracing.ts";

const file = (name: string) => ({ name }) as unknown as File;

const fileEntry = (name: string, value = file(name)): FileSystemFileEntry =>
  ({
    file: (resolve: (file: File) => void) => resolve(value),
    isDirectory: false,
    isFile: true,
    name,
  }) as FileSystemFileEntry;

const directoryEntry = (name: string, batches: FileSystemEntry[][]): FileSystemDirectoryEntry => {
  let index = 0;
  return {
    createReader: () => ({
      readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(batches[index++] || []),
    }),
    isDirectory: true,
    isFile: false,
    name,
  } as FileSystemDirectoryEntry;
};

const transfer = (items: unknown[], files: File[] = []): DataTransfer =>
  ({
    files: files as unknown as FileList,
    items: items as DataTransferItemList,
  }) as DataTransfer;

describe("dropped file collection", () => {
  it("uses the flat file list when entry APIs are not available", async () => {
    const visible = file("game.bin");
    const hidden = file(".DS_Store");
    await expect(readDataTransferFiles(transfer([{ kind: "file" }], [visible, hidden]))).resolves.toEqual([visible]);
  });

  it("recurses through directory batches and keeps null-entry files", async () => {
    const direct = file("direct.bin");
    const nested = file("nested.bin");
    const hidden = file(".hidden.bin");
    const directory = directoryEntry("folder", [
      [fileEntry("nested.bin", nested), fileEntry(".hidden.bin", hidden)],
      [],
    ]);
    const items = [
      { kind: "file", webkitGetAsEntry: () => directory },
      { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => direct },
      { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => hidden },
      { kind: "string", webkitGetAsEntry: () => fileEntry("ignored.bin") },
    ];
    await expect(readDataTransferFiles(transfer(items))).resolves.toEqual([nested, direct]);
  });

  it("drops entries that fail to read and continues after directory errors", async () => {
    const failedFile = {
      file: (_resolve: (file: File) => void, reject: (error: Error) => void) => reject(new Error("file failed")),
      isDirectory: false,
      isFile: true,
      name: "broken.bin",
    } as FileSystemFileEntry;
    const failedDirectory = {
      createReader: () => ({
        readEntries: (_resolve: (entries: FileSystemEntry[]) => void, reject: (error: Error) => void) =>
          reject(new Error("directory failed")),
      }),
      isDirectory: true,
      isFile: false,
      name: "broken",
    } as FileSystemDirectoryEntry;
    await expect(
      readDataTransferFiles(
        transfer([
          { kind: "file", webkitGetAsEntry: () => failedFile },
          { kind: "file", webkitGetAsEntry: () => failedDirectory },
          { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false, isFile: false, name: "unknown" }) },
        ]),
      ),
    ).resolves.toEqual([]);
    await expect(readDataTransferFiles(null)).resolves.toEqual([]);
  });
});

describe("sidecar patch resolution", () => {
  beforeEach(() => sidecarWorker.runRomWeaverIngestSidecarsWorker.mockReset());

  it("maps Rust's ordered matches and derives labels from nested names", async () => {
    sidecarWorker.runRomWeaverIngestSidecarsWorker.mockResolvedValue([
      { name: "patches/second [Second Fix].ips", order: 2 },
      { name: "first.ips", order: 1 },
      { name: "unknown.ips", order: 3 },
    ]);
    const first = { filename: "first.ips", marker: 1 };
    const duplicate = { filename: "first.ips", marker: 2 };
    const second = { fileName: "patches/second [Second Fix].ips", marker: 3 };
    const resolved = await resolveSidecarPatchEntries("game.sfc", [first, duplicate, second]);
    expect(sidecarWorker.runRomWeaverIngestSidecarsWorker).toHaveBeenCalledWith({
      patchNames: ["first.ips", "patches/second [Second Fix].ips"],
      romName: "game.sfc",
    });
    expect(resolved).toEqual([
      { entry: second, fileName: "patches/second [Second Fix].ips", order: 2, outputLabel: "Second Fix" },
      { entry: first, fileName: "first.ips", order: 1, outputLabel: undefined },
    ]);
  });

  it("handles empty names and applies generated labels in place", async () => {
    await expect(resolveSidecarPatchEntries("game.sfc", [])).resolves.toEqual([]);
    expect(sidecarWorker.runRomWeaverIngestSidecarsWorker).not.toHaveBeenCalled();
    expect(getSidecarPatchOutputLabel("folder/patch [Label].bps")).toBe("Label");
    expect(getSidecarPatchOutputLabel("patch.bps")).toBeUndefined();
    const output = { fileName: "patch.ips" };
    expect(applySidecarPatchOutputLabel(output, "Generated")).toBe(output);
    expect(output).toEqual({ fileName: "patch.ips", _generatedPatchName: "Generated" });
    expect(applySidecarPatchOutputLabel(output, undefined)).toBe(output);
  });
});

describe("validated archive patch cache", () => {
  it("reuses a cache and releases every cached leaf once", async () => {
    const archive = {} as never;
    const leaf = { fileName: "fix.ips", _cleanup: vi.fn(async () => undefined) } as never;
    const cache = getValidatedPatchArchiveEntryCache(archive);
    cache.set("fix.ips", leaf);
    expect(getValidatedPatchArchiveEntryCache(archive)).toBe(cache);
    ensureValidatedPatchArchiveEntryCleanup(archive);
    ensureValidatedPatchArchiveEntryCleanup(archive);
    const cleanup = getPatchFileCleanup(archive);
    expect(cleanup).toBeDefined();
    await cleanup?.();
    await cleanup?.();
    expect(leaf._cleanup).toHaveBeenCalledTimes(1);
    expect(getValidatedPatchArchiveEntryCache(archive)).not.toBe(cache);
  });

  it("does not retain an empty cache and swallows leaf cleanup errors", async () => {
    const emptyArchive = {} as never;
    const empty = getValidatedPatchArchiveEntryCache(emptyArchive);
    expect(getValidatedPatchArchiveEntryCache(emptyArchive)).toBe(empty);
    const archive = {} as never;
    const failed = {
      fileName: "failed.ips",
      _cleanup: vi.fn(async () => {
        throw new Error("cleanup");
      }),
    } as never;
    getValidatedPatchArchiveEntryCache(archive).set("failed.ips", failed);
    ensureValidatedPatchArchiveEntryCleanup(archive);
    await expect(getPatchFileCleanup(archive)?.()).resolves.toBeUndefined();
  });
});

describe("browser source normalization", () => {
  it("accepts browser binary sources and rejects paths or missing sources", () => {
    expect(() => assertBrowserBinarySource(new Blob(["bytes"]) as never, "create")).not.toThrow();
    expect(() => assertBrowserBinarySource({ kind: "file", getFile: vi.fn() } as never, "create")).not.toThrow();
    expect(() => assertBrowserBinarySource({ vfs: {}, path: "/game.bin" } as never, "create")).not.toThrow();
    expect(() => assertBrowserBinarySource("/tmp/game.bin" as never, "create")).toThrow(
      "create does not accept filesystem paths in browser workflows",
    );
    expect(() => assertBrowserBinarySource({ source: "  " } as never, "create")).toThrow(
      "create requires a Blob, FileSystemFileHandle, or VFS path in browser workflows",
    );
  });

  it("normalizes typed archive data without sharing view buffers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const view = new DataView(bytes.buffer, 1, 2);
    const owned = getArchiveEntryArrayBuffer(view as never) as ArrayBuffer;
    expect(new Uint8Array(owned)).toEqual(new Uint8Array([2, 3]));
    expect(owned).not.toBe(bytes.buffer);
    expect(getArchiveEntryArrayBuffer(bytes.buffer as never)).toBe(bytes.buffer);
    expect(getArchiveEntryArrayBuffer({} as never)).toBeUndefined();
    expect(getArchiveEntryUint8Array(bytes as never)).toBe(bytes);
    expect(getArchiveEntryUint8Array(view as never)).toEqual(new Uint8Array([2, 3]));
    expect(getArchiveEntryUint8Array(bytes.buffer as never)).toBeUndefined();
    expect(toWorkerMetadata({ keep: "value", remove: undefined } as never)).toEqual({ keep: "value" });
  });
});

describe("create patch format policy", () => {
  it("normalizes aliases and selects size buckets", () => {
    expect(normalizeCreatePatchFormat(" Bsdiff40 ")).toBe("bdf");
    expect(normalizeCreatePatchFormat("vcdiff")).toBe("xdelta");
    expect(getCreatePatchFormatsForSizes(0)[0]).toBe("bps");
    expect(getCreatePatchFormatsForSizes(16_777_217)[0]).toBe("bps");
    expect(getCreatePatchFormatsForSizes(134_217_729)[0]).toBe("xdelta");
    expect(getCreatePatchFormatsForSizes(268_435_457)).toEqual(["xdelta", "ppf"]);
    expect(getCreatePatchFormatsForSizes(Number.NaN)).toEqual(expect.arrayContaining(["bps", "ips"]));
  });

  it("honors candidate defaults, automatic selection, and safe fallbacks", () => {
    expect(
      getPreferredCreatePatchFormat({ candidateFormats: ["vcdiff", "vcdiff", " BPS "], candidateDefaultFormat: "bps" }),
    ).toBe("bps");
    expect(
      getPreferredCreatePatchFormat({
        candidateFormats: ["vcdiff", "bps"],
        candidateDefaultFormat: "ips",
        requestedFormat: "ips",
      }),
    ).toBe("xdelta");
    expect(getPreferredCreatePatchFormat({ candidateFormats: ["vcdiff", "bps"], requestedFormat: "auto" })).toBe(
      "xdelta",
    );
    expect(
      getPreferredCreatePatchFormat({
        candidateFormats: ["vcdiff", "bps"],
        requestedFormat: "auto",
        automaticFormatSelection: false,
      }),
    ).toBe("xdelta");
    expect(getPreferredCreatePatchFormat({ modifiedSize: 300_000_000, originalSize: 1 })).toBe("xdelta");
  });
});

describe("workflow source preparation", () => {
  it("detects selected entries, archives, ROM-specific inputs, and disabled extraction", () => {
    expect(shouldPrepareWorkflowSource("game.bin" as never, undefined, "entry.bin")).toBe(true);
    expect(shouldPrepareWorkflowSource("game.zip" as never, undefined, undefined)).toBe(true);
    expect(
      shouldPrepareWorkflowSource("game.zip" as never, { input: { containerInputsEnabled: false } }, undefined),
    ).toBe(false);
    expect(shouldPrepareWorkflowSource("game.chd" as never, undefined, undefined)).toBe(true);
    expect(shouldPrepareWorkflowSource("game.bin" as never, undefined, undefined)).toBe(false);
    expect(
      shouldPrepareWorkflowSource({ fileName: "game.zip", source: new Blob(["x"]) } as never, undefined, undefined),
    ).toBe(true);
  });

  it("resolves names from direct sources and rounds only valid timings", () => {
    expect(getWorkflowSourceFileName({ fileName: "named.bin", source: "/tmp/other.bin" } as never, "fallback")).toBe(
      "named.bin",
    );
    expect(getWorkflowSourceFileName("https://host/path/game.bin?hash=1" as never, "fallback")).toBe("game.bin?hash=1");
    expect(getWorkflowSourceFileName("C:\\games\\game.bin#part" as never, "fallback")).toBe("game.bin#part");
    expect(getWorkflowSourceFileName({ source: "" } as never, "fallback")).toBe("fallback");
    expect(roundElapsedMs({ elapsedMs: 4.6 })).toBe(5);
    expect(roundElapsedMs({ elapsedMs: -1 })).toBeUndefined();
    expect(roundElapsedMs({ elapsedMs: Number.NaN })).toBeUndefined();
    expect(roundElapsedMs(undefined)).toBeUndefined();
  });
});

describe("automatic patch labels and tracing", () => {
  it("sanitizes metadata and composes redundant and bracket labels", () => {
    expect(createPatchMetadataLabel(null)).toBe("");
    expect(createPatchMetadataLabel({ name: "Fix<>", author: "A/B", version: "1.0" })).toBe("[Fix A B 1.0]");
    expect(buildPatchedOutputBaseName("Game", ["Game Update", "other [Label]", "[[nested]]"])).toBe(
      "Game [Update] [Label] [nested]",
    );
    expect(buildPatchedOutputBaseName("", ["  ", "patch"])).toBe("patched [patch]");
  });

  it("emits trace stages only at trace level and reports success or failure", async () => {
    const onLog = vi.fn();
    const options = {
      logging: { level: "trace" },
      onLog,
      trace: { operationId: "op-1", workflow: "apply", workflowId: "wf-1" },
    } as never;
    const tracer = createWorkflowTracer("apply");
    tracer.traceWorkflowStage(options, "stage.start", "input", "rom", { detail: 1 });
    await tracer.traceWorkflowStageBlock(
      options,
      "apply",
      "worker",
      async () => "done",
      () => ({ detail: 2 }),
    );
    await expect(
      tracer.traceWorkflowStageBlock(options, "fail", undefined, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    traceWorkflowControllerEvent(
      { logLevel: "trace", onLog, workflow: "apply", workflowId: "wf-1" },
      "controller.event",
      { detail: 3 },
    );
    expect(onLog.mock.calls.map(([record]) => record.message)).toEqual([
      "stage.start",
      "stage.start",
      "stage.finish",
      "stage.start",
      "stage.fail",
      "controller.event",
    ]);
    const quiet = createWorkflowTracer("create");
    quiet.traceWorkflowStage({ logging: { level: "debug" } } as never, "stage.start", undefined);
    traceWorkflowControllerEvent({ logLevel: "debug", workflow: "create" }, "ignored");
    expect(onLog).toHaveBeenCalledTimes(6);
  });
});

describe("runtime option normalization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes worker options and forwards trace callbacks", () => {
    const onEvent = vi.fn();
    const onLog = vi.fn();
    const virtualFiles = [{ path: "/virtual/file", data: new Uint8Array([1]) }];
    const options = toRomWeaverOptions({
      defaultThreads: 3.9,
      interactiveSelectionEnabled: true,
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: [" /a ", "", " /b "],
      logLevel: "TRACE",
      onEvent,
      onLog,
      signal: new AbortController().signal,
      syncAccessMode: " readwrite ",
      virtualFiles: virtualFiles as never,
      virtualOnlyMounts: false,
    });
    expect(options).toMatchObject({
      defaultThreads: 3,
      env: { RUST_BACKTRACE: "full" },
      interactiveSelectionEnabled: true,
      invalidateMountCacheBeforeRun: true,
      knownInputPaths: ["/a", "/b"],
      log_level: "TRACE",
      signal: expect.any(AbortSignal),
      syncAccessMode: "readwrite",
      virtualFiles,
      virtualOnlyMounts: false,
    });
    expect(options.onEvent).toBe(onEvent);
    options.onTraceEvent?.({ event: "trace" } as never);
    options.onTraceEvent?.({
      circular: (() => {
        const value: Record<string, unknown> = {};
        value.self = value;
        return value;
      })(),
    } as never);
    options.onTraceNonJsonLine?.("[perf] 12ms");
    options.onTraceNonJsonLine?.(" trace line ");
    options.onTraceNonJsonLine?.("   ");
    expect(onLog.mock.calls.map(([record]) => [record.level, record.message])).toEqual([
      ["trace", '{"event":"trace"}'],
      ["trace", "[object Object]"],
      ["info", "[perf] 12ms"],
      ["trace", "trace line"],
    ]);
  });

  it("rejects invalid sync modes and exposes explicit trace helpers", () => {
    expect(isTraceEnabled("TRACE")).toBe(true);
    expect(isTraceEnabled("debug")).toBe(false);
    expect(
      toRomWeaverOptions({ defaultThreads: Number.NaN, logLevel: "debug", syncAccessMode: "invalid" }),
    ).toMatchObject({
      onTraceEvent: undefined,
    });
    const onLog = vi.fn();
    emitRuntimeTrace({ logLevel: "trace", onLog }, "message", { key: "value" });
    emitRuntimeTrace({ logLevel: "debug", onLog }, "ignored");
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: "trace", message: "message", details: { key: "value" } }),
    );
    expect(onLog).toHaveBeenCalledTimes(1);
  });
});
