import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assert as assertGuest,
  assertBytesEqual,
  assertRunJsonSucceeded,
  errorMessage,
  getTerminalEvent,
  joinGuestPath,
  pathBasename,
  pathDirname,
  readGuestFile,
  removeFixtureDirectory,
  toBytes,
  waitForGuestFile,
  writeGuestFile,
} from "../../src/wasm/browser-matrix-guest-io.ts";
import {
  createThreadIdState,
  allocateThreadId,
  MAX_WASI_THREAD_ID,
  signalThreadStartState,
  THREAD_SLOT_LENGTH,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_RUNNING,
  THREAD_SLOT_STATE_SHUTDOWN,
  THREAD_SLOT_STATE_STARTING,
  threadStartControlFromBuffer,
  waitForAtomicsStateChange,
  waitForThreadStartAck,
} from "../../src/wasm/browser-wasi-thread-protocol.ts";
import {
  canUseThreadedWasm,
  getChdCodecLevelMax,
  getDefaultBrowserThreadCount,
  getDefaultThreadCount,
  isValidChdCodecLevel,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeIntegerInRange,
  parseIntegerInRange,
} from "../../src/platform/shared/compression-options.ts";
import {
  createPublicSourceValidator,
  createPublicSourcesValidator,
} from "../../src/platform/shared/public-source-validation.ts";
import {
  contextualizeRuntimeLabel,
  forwardArchiveProgress,
  forwardCreatePatchProgress,
  forwardRomSpecificProgress,
} from "../../src/platform/shared/workflow-runtime-progress.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "../../src/workers/rom-weaver/runner-errors.ts";

class FakeFileHandle {
  kind = "file" as const;

  constructor(
    readonly name: string,
    private bytes = new Uint8Array(),
  ) {}

  async getFile() {
    return new File([this.bytes], this.name);
  }

  async createWritable() {
    return {
      close: async () => undefined,
      write: async (contents: Uint8Array) => {
        this.bytes = new Uint8Array(contents);
      },
    };
  }
}

class FakeDirectoryHandle {
  kind = "directory" as const;
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  removed: Array<{ name: string; recursive: boolean }> = [];

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const directory = new FakeDirectoryHandle();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new DOMException("missing", "NotFoundError");
    const file = new FakeFileHandle(name);
    this.files.set(name, file);
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }) {
    this.removed.push({ name, recursive: options?.recursive === true });
    if (!(this.files.delete(name) || this.directories.delete(name))) throw new DOMException("missing", "NotFoundError");
  }
}

const runResult = (overrides: Record<string, unknown> = {}) => ({
  error: undefined,
  events: [{ command: "compress", label: "done", status: "succeeded" }],
  exitCode: 0,
  ok: true,
  stderr: "",
  ...overrides,
});

describe("browser matrix guest IO helpers", () => {
  it("validates equality, converts supported byte inputs, and formats paths", () => {
    expect(() => assertGuest(true, "ok")).not.toThrow();
    expect(() => assertGuest(false, "bad")).toThrow("bad");
    expect(() => assertBytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]), "same")).not.toThrow();
    expect(() => assertBytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]), "different length")).toThrow(
      "length 1 !== 2",
    );
    expect(() => assertBytesEqual(new Uint8Array([1, 3]), new Uint8Array([1, 2]), "different byte")).toThrow(
      "byte 1 3 !== 2",
    );
    expect(toBytes("rom")).toEqual(new Uint8Array([114, 111, 109]));
    const bytes = new Uint8Array([1, 2]);
    expect(toBytes(bytes)).toBe(bytes);
    expect(toBytes(bytes.buffer)).toEqual(bytes);
    expect(() => toBytes(4 as never)).toThrow("expected string, Uint8Array, or ArrayBuffer");
    expect(joinGuestPath("/work/", "/nested", "file.bin")).toBe("/work/nested/file.bin");
    expect(pathBasename("/work/nested/file.bin/")).toBe("file.bin");
    expect(pathDirname("/work/nested/file.bin/")).toBe("/work/nested");
    expect(pathDirname("file.bin")).toBe("/");
    expect(errorMessage(new Error("failed"))).toBe("failed");
    expect(errorMessage("failed")).toBe("failed");
    expect(errorMessage(null)).toBe("");
    expect(errorMessage({ message: "ignored" })).toBe("[object Object]");
  });

  it("reads and writes nested guest files and removes fixture directories", async () => {
    const root = new FakeDirectoryHandle();
    await writeGuestFile(root as never, "/work/nested/game.bin", new Uint8Array([4, 5]));
    expect(await readGuestFile(root as never, "/work/nested/game.bin")).toEqual(new Uint8Array([4, 5]));
    await removeFixtureDirectory(root as never, "fixture");
    expect(root.removed).toEqual([{ name: "fixture", recursive: true }]);

    const missingRoot = new FakeDirectoryHandle();
    missingRoot.removeEntry = async () => {
      throw new Error("locked");
    };
    await expect(removeFixtureDirectory(missingRoot as never, "fixture")).resolves.toBeUndefined();
    await expect(readGuestFile(root as never, "/outside.bin")).rejects.toThrow("guest path must start with /work/");
  });

  it("waits for output visibility and reports command failures with context", async () => {
    const root = new FakeDirectoryHandle();
    const pending = waitForGuestFile(root as never, "/work/output.bin", runResult());
    await expect(pending).rejects.toThrow("command succeeded without output /work/output.bin");

    const delayed = new FakeDirectoryHandle();
    let attempts = 0;
    delayed.getFileHandle = async (name: string) => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("not ready", "NotFoundError");
      return new FakeFileHandle(name, new Uint8Array([1]));
    };
    await expect(waitForGuestFile(delayed as never, "/work/output.bin", runResult())).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    expect(getTerminalEvent(runResult())).toMatchObject({ status: "succeeded" });
    expect(() => getTerminalEvent({ events: [] })).toThrow("at least one event");
    expect(() => getTerminalEvent({ events: [undefined] })).toThrow("terminal event");
    expect(() => getTerminalEvent({})).toThrow("include events");
    expect(assertRunJsonSucceeded(runResult(), { command: "compress" })).toMatchObject({ status: "succeeded" });
    expect(() => assertRunJsonSucceeded(runResult({ exitCode: 1, ok: false }), { command: "compress" })).toThrow(
      "expected compress to succeed",
    );
    expect(() =>
      assertRunJsonSucceeded(runResult({ events: [{ command: "other", status: "succeeded" }] }), {
        command: "compress",
      }),
    ).toThrow("expected terminal command compress");
  });
});

describe("compression option normalization", () => {
  it("detects threaded environments and clamps default counts", () => {
    expect(canUseThreadedWasm({ crossOriginIsolated: true })).toBe(true);
    expect(canUseThreadedWasm({ crossOriginIsolated: false })).toBe(false);
    expect(canUseThreadedWasm(null)).toBe(false);
    expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: 2 } })).toBe(4);
    expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: 128 } })).toBe(64);
    expect(getDefaultThreadCount({ navigator: { hardwareConcurrency: 7.9 } })).toBe(7);
    expect(getDefaultBrowserThreadCount({ crossOriginIsolated: false })).toBe(1);
    expect(getDefaultBrowserThreadCount({ crossOriginIsolated: true, navigator: { hardwareConcurrency: 8 } })).toBe(8);
    expect(normalizeBrowserThreadCount("off", { crossOriginIsolated: true })).toBe(0);
    expect(normalizeBrowserThreadCount(999, { crossOriginIsolated: true })).toBe(64);
    expect(normalizeBrowserThreadCount("auto", { crossOriginIsolated: false })).toBe(1);
    expect(normalizeBrowserThreadCount(undefined, { crossOriginIsolated: true }, 9)).toBe(9);
  });

  it("normalizes codecs and integer ranges with explicit failure policies", () => {
    expect(normalizeCodecList(" deflate:6, zstd ", { allowLevels: true })).toBe("deflate:6,zstd");
    expect(
      normalizeCodecList(["huff", "store"], { isValidCodec: (codec) => codec === "huff" || codec === "store" }),
    ).toBe("huff,store");
    expect(normalizeCodecListWithFallback("bad codec", "zstd")).toBe("zstd");
    expect(normalizeCodecListWithFallback(undefined, "deflate")).toBe("deflate");
    expect(() => normalizeCodecList("zstd:99", { allowLevels: true, isValidLevel: () => false })).toThrow(
      "Unsupported codec level",
    );
    expect(() =>
      normalizeCodecList("unknown", { isValidCodec: () => false, getErrorMessage: (codec) => `bad ${codec}` }),
    ).toThrow("bad unknown");
    expect(parseIntegerInRange(" 4 ", { min: 1, max: 8, requireExactString: false })).toBe(4);
    expect(parseIntegerInRange("", { allowEmpty: true, min: 1, max: 8 })).toBeNull();
    expect(() => parseIntegerInRange("bad", { fallback: 3, min: 1, max: 8 })).toThrow("Invalid value: bad");
    expect(() => parseIntegerInRange("04", { min: 1, max: 8, requireExactString: true })).toThrow("Invalid value: 04");
    expect(normalizeIntegerInRange("100", { fallback: "", min: 1, max: 8 })).toBe(8);
    expect(normalizeIntegerInRange("bad", { fallback: 2, min: 1, max: 8 })).toBe(2);
    expect(normalizeIntegerInRange("", { fallback: "", min: 1, max: 8 })).toBe("");
    expect(getChdCodecLevelMax("zstd")).toBe(22);
    expect(isValidChdCodecLevel("zstd", 22)).toBe(true);
    expect(isValidChdCodecLevel("zstd", 23)).toBe(false);
    expect(isValidChdCodecLevel("missing", 1)).toBe(false);
  });
});

describe("public source validation", () => {
  it("accepts browser source shapes and rejects private source kinds", () => {
    const validate = createPublicSourceValidator({ environmentLabel: "browser" });
    expect(() => validate(new Blob(["rom"]))).not.toThrow();
    expect(() => validate({ source: new Blob(["rom"]) })).not.toThrow();
    expect(() => validate({ kind: "file", getFile: async () => new File(["rom"], "rom.bin") })).not.toThrow();
    expect(() => validate(new Uint8Array([1]))).toThrow("Raw byte sources are not public browser inputs");
    expect(() => validate({ data: new ArrayBuffer(1) })).toThrow("Raw byte source wrappers");
    expect(() => validate("/work/input.bin")).toThrow("Path strings are not public browser inputs");
    expect(() => validate({ source: "/work/input.bin" })).toThrow("Path source wrappers");
    expect(() => validate({ path: "/work/input.bin", vfs: {} })).toThrow("VFS path refs");
    expect(() => validate({ source: { path: "/work/input.bin", vfs: {} } })).toThrow("VFS path ref wrappers");
    expect(() => validate({ nope: true })).toThrow("public sources must be Blob values");
    const assertOne = vi.fn();
    const validateMany = createPublicSourcesValidator(assertOne);
    validateMany(undefined);
    validateMany({ value: 1 });
    validateMany([{ value: 2 }, { value: 3 }]);
    expect(assertOne.mock.calls.map(([value]) => value)).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });
});

describe("workflow progress forwarding", () => {
  it("forwards patch, ROM-specific, and archive progress with normalized labels", () => {
    const patchProgress = vi.fn();
    forwardCreatePatchProgress(patchProgress)({ label: "creating bps", percent: 12 });
    expect(patchProgress).toHaveBeenCalledWith({ label: "creating bps", percent: 12 });

    const romProgress = vi.fn();
    const forwardRom = forwardRomSpecificProgress("output", romProgress, "Creating game.rvz...");
    forwardRom?.({ label: "creating rvz (120%)", percent: -10, details: { file: "game" } });
    expect(romProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Creating game.rvz (120%)", percent: 0, stage: "output" }),
    );
    expect(forwardRomSpecificProgress("input")).toBeUndefined();

    const archiveProgress = vi.fn();
    const forwardArchive = forwardArchiveProgress("input", archiveProgress, "Extracting archive.zip...");
    forwardArchive({ details: { member: "game.bin" }, percent: 0, stage: "extract" });
    forwardArchive({ details: "raw", label: "extracting zip", percent: 40, stage: "extract" });
    forwardArchive({ percent: 100 });
    expect(archiveProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        details: { member: "game.bin", runtimeStage: "extract" },
        percent: null,
        stage: "input",
      }),
    );
    expect(archiveProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({ percent: 40 }));
    expect(archiveProgress).toHaveBeenNthCalledWith(3, expect.objectContaining({ percent: 100 }));
    expect(contextualizeRuntimeLabel("reading rvz (2/3)", "Reading game.rvz...")).toBe("Reading game.rvz (2/3)");
  });
});

describe("runner failure messages", () => {
  it("uses terminal labels, non-JSON lines, structured errors, and stderr in order", () => {
    expect(getRomWeaverFailureMessage(runResult({ events: [{ status: "failed", label: "terminal failure" }] }))).toBe(
      "terminal failure",
    );
    expect(getRomWeaverFailureMessage({ nonJsonLines: ["", "raw failure"] })).toBe("raw failure");
    expect(
      getRomWeaverFailureMessage({ error: { message: "bad input", context: { command: "probe", stage: "read" } } }),
    ).toBe("bad input (command=probe, stage=read)");
    expect(getRomWeaverFailureMessage({ error: { kind: "cancelled" } })).toBe("rom-weaver error (cancelled)");
    expect(getRomWeaverFailureMessage({ error: new Error("boom") })).toBe("boom");
    expect(getRomWeaverFailureMessage({ stderr: "2026-01-01T00:00:00Z INFO runtime: trace\nreal failure" })).toBe(
      "real failure",
    );
    expect(getRomWeaverFailureMessage(null, "fallback")).toBe("fallback");
    const error = new Error("wrapped");
    expect(withRomWeaverFailureKind(error, { events: [{ status: "failed", error_kind: "validation" }] })).toBe(error);
    expect((error as Error & { kind?: string }).kind).toBe("validation");
  });
});

describe("thread-start protocol", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("allocates shared ids, validates control buffers, and signals states", () => {
    const ids = createThreadIdState();
    expect(allocateThreadId(ids)).toBe(43);
    expect(allocateThreadId(ids)).toBe(44);
    expect(allocateThreadId(new Int32Array(1))).toBe(-52);
    const exhausted = createThreadIdState();
    exhausted[0] = MAX_WASI_THREAD_ID + 1;
    expect(allocateThreadId(exhausted)).toBe(-6);
    expect(
      threadStartControlFromBuffer(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH)),
    ).toBeInstanceOf(Int32Array);
    expect(threadStartControlFromBuffer(new ArrayBuffer(16))).toBeNull();
    expect(threadStartControlFromBuffer(new SharedArrayBuffer(4))).toBeNull();
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    signalThreadStartState(control, THREAD_SLOT_STATE_RUNNING);
    expect(Atomics.load(control, THREAD_SLOT_STATE_INDEX)).toBe(THREAD_SLOT_STATE_RUNNING);
    signalThreadStartState(null, THREAD_SLOT_STATE_IDLE);
  });

  it("returns atomics transitions, timeouts, aborts, and start errors", () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_RUNNING;
    expect(waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE)).toBe("not-equal");
    expect(
      waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE, { deadline: Date.now() - 1 }),
    ).toBe("timed-out");
    expect(
      waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE, {
        deadline: Date.now() + 10,
        shouldAbort: () => true,
      }),
    ).toBe("aborted");
    expect(waitForThreadStartAck(control, 9)).toBeNull();

    for (const [state, message] of [
      [THREAD_SLOT_STATE_FAILED, "failed before start acknowledgement"],
      [THREAD_SLOT_STATE_SHUTDOWN, "was shut down before start acknowledgement"],
      [99, "entered unexpected start state 99"],
    ] as const) {
      control[THREAD_SLOT_STATE_INDEX] = state;
      expect(waitForThreadStartAck(control, 9)?.message).toBe(`wasi thread 9 ${message}`);
    }
    control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_STARTING;
    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_RUNNING;
      return "not-equal";
    });
    expect(waitForThreadStartAck(control, 10)).toBeNull();
    expect(wait).toHaveBeenCalled();
  });
});
