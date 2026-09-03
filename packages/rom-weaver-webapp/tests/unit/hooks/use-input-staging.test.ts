// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ApplyWorkflowStageSnapshot,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "../../../src/public/react/apply-session-types.ts";
import { resolveLocalStateUpdate } from "../../../src/public/react/patcher-form-session-utils.ts";
import type { BinarySource } from "../../../src/public/react/patcher-form.ts";
import { useStageGenerationMachine } from "../../../src/public/react/apply-session-staging-state-machine.ts";
import { useInputStaging } from "../../../src/public/react/use-input-staging.ts";

const source = (name: string, size = 1024): BinarySource => ({ name, size }) as unknown as BinarySource;

// Mirrors the real functional-setter contract from useLocalPatcherSessionState: a spy that also
// keeps real state so a later call's "current" argument reflects prior updates, matching what the
// production reducer does. Needed for partial-staging assertions that inspect merge behavior against
// previously-set rows, not just the latest call's raw argument.
const makeStatefulSetter = <T>(initial: T) => {
  let value = initial;
  const spy = vi.fn((update: T | ((current: T) => T)) => {
    value = resolveLocalStateUpdate(value, update);
    return value;
  });
  return {
    spy,
    get value() {
      return value;
    },
  };
};

const disposedError = () => {
  const error = new Error("workflow disposed") as Error & { code: string };
  error.code = "WORKFLOW_DISPOSED";
  return error;
};

const snapshotOf = (inputs: BinarySource[], patches: BinarySource[] = []): ApplyWorkflowStageSnapshot =>
  ({
    inputs,
    options: { output: { compression: "auto" } },
    patches,
  }) as unknown as ApplyWorkflowStageSnapshot;

const infoFor = (source: BinarySource, order: number): StagedInputInfo => ({
  checksums: { crc32: "aaaaaaaa", md5: "", sha1: "" },
  fileName: (source as unknown as { name: string }).name,
  id: (source as unknown as { name: string }).name,
  order,
  size: (source as unknown as { size: number }).size,
});

// Builds a fresh InputStagingContext with every field faked as a plain object/vi.fn spy, plus a
// handful of stateful setters (romInputs, patchInfoByKey, etc.) so tests can assert on the
// accumulated state, not just individual call args. `stage` functions default to unset; each test
// installs the ones it needs (stageInput / stagePatches / validatePatches).
const createHarness = (overrides: { stageInput?: LocalApplyPatchFormSessionOptions["stageInput"] } = {}) => {
  const romInputsSetter = makeStatefulSetter<unknown[]>([]);
  const inputStagingSetter = makeStatefulSetter(false);
  const patchStagingSetter = makeStatefulSetter(false);
  const patchInfoByKeySetter = makeStatefulSetter<Record<string, StagedInputInfo>>({});
  const patchProgressSetter = makeStatefulSetter<unknown>(null);
  const patchProgressByKeySetter = makeStatefulSetter<Record<string, unknown>>({});

  const emitSessionTrace = vi.fn();
  const onError = vi.fn();
  const setSectionErrorMessage = vi.fn();
  const mergeRomInput = vi.fn();
  const reclassifyArchiveToPatch = vi.fn();
  const updatePatches = vi.fn();

  const getInputKey = (src: BinarySource) => (src as unknown as { name: string }).name;
  const getPatchKey = (src: BinarySource) => (src as unknown as { name: string }).name;
  const getStableInputInfo = (info: StagedInputInfo) => info;

  const stageInput = overrides.stageInput;

  const { result, unmount } = renderHook(() => {
    const inputStageMachine = useStageGenerationMachine();
    const patchStageMachine = useStageGenerationMachine();
    const staging = useInputStaging({
      machines: { inputStageMachine, patchStageMachine },
      report: { emitSessionTrace, onError, setSectionErrorMessage },
      rows: {
        getInputKey,
        getPatchKey,
        getStableInputInfo,
        mergeRomInput,
        reclassifyArchiveToPatch,
        updatePatches,
      },
      session: {
        setInputStaging: inputStagingSetter.spy,
        setPatchInfoByKey: patchInfoByKeySetter.spy,
        setPatchProgress: patchProgressSetter.spy,
        setPatchProgressByKey: patchProgressByKeySetter.spy,
        setPatchStaging: patchStagingSetter.spy,
        setRomInputs: romInputsSetter.spy,
      },
      stage: { stageInput, stagePatches: undefined, validatePatches: undefined },
    });
    return { inputStageMachine, patchStageMachine, staging };
  });

  return {
    emitSessionTrace,
    inputStagingSetter,
    mergeRomInput,
    onError,
    patchInfoByKeySetter,
    patchProgressByKeySetter,
    patchProgressSetter,
    patchStagingSetter,
    reclassifyArchiveToPatch,
    result,
    romInputsSetter,
    setSectionErrorMessage,
    unmount,
    updatePatches,
  };
};

// Second harness variant that also exposes patch staging hooks (stagePatches / validatePatches),
// used by the syncPatchFiles-focused tests.
const createPatchHarness = (
  overrides: {
    stagePatches?: LocalApplyPatchFormSessionOptions["stagePatches"];
    validatePatches?: LocalApplyPatchFormSessionOptions["validatePatches"];
  } = {},
) => {
  const romInputsSetter = makeStatefulSetter<unknown[]>([]);
  const inputStagingSetter = makeStatefulSetter(false);
  const patchStagingSetter = makeStatefulSetter(false);
  const patchInfoByKeySetter = makeStatefulSetter<Record<string, StagedInputInfo>>({});
  const patchProgressSetter = makeStatefulSetter<unknown>(null);
  const patchProgressByKeySetter = makeStatefulSetter<Record<string, unknown>>({});

  const emitSessionTrace = vi.fn();
  const onError = vi.fn();
  const setSectionErrorMessage = vi.fn();
  const mergeRomInput = vi.fn();
  const reclassifyArchiveToPatch = vi.fn();
  const updatePatches = vi.fn();

  const getInputKey = (src: BinarySource) => (src as unknown as { name: string }).name;
  const getPatchKey = (src: BinarySource) => (src as unknown as { name: string }).name;
  const getStableInputInfo = (info: StagedInputInfo) => info;

  const { result } = renderHook(() => {
    const inputStageMachine = useStageGenerationMachine();
    const patchStageMachine = useStageGenerationMachine();
    const staging = useInputStaging({
      machines: { inputStageMachine, patchStageMachine },
      report: { emitSessionTrace, onError, setSectionErrorMessage },
      rows: {
        getInputKey,
        getPatchKey,
        getStableInputInfo,
        mergeRomInput,
        reclassifyArchiveToPatch,
        updatePatches,
      },
      session: {
        setInputStaging: inputStagingSetter.spy,
        setPatchInfoByKey: patchInfoByKeySetter.spy,
        setPatchProgress: patchProgressSetter.spy,
        setPatchProgressByKey: patchProgressByKeySetter.spy,
        setPatchStaging: patchStagingSetter.spy,
        setRomInputs: romInputsSetter.spy,
      },
      stage: {
        stageInput: undefined,
        stagePatches: overrides.stagePatches,
        validatePatches: overrides.validatePatches,
      },
    });
    return { patchStageMachine, staging };
  });

  return {
    emitSessionTrace,
    onError,
    patchInfoByKeySetter,
    patchProgressByKeySetter,
    patchProgressSetter,
    patchStagingSetter,
    result,
    setSectionErrorMessage,
  };
};

describe("useInputStaging syncRomInput", () => {
  it("resets staging state when there is no first input or no stageInput handler", () => {
    const { inputStagingSetter, romInputsSetter, result } = createHarness();
    act(() => result.current.staging.syncRomInput(snapshotOf([])));
    expect(inputStagingSetter.value).toBe(false);
    expect(romInputsSetter.value).toEqual([]);
  });

  it("stages an input end to end: pending row first, then a finalized row", async () => {
    let resolveStage: (infos: StagedInputInfo[]) => void = () => undefined;
    const rom = source("rom.bin");
    const stageInput = vi.fn(
      (_snapshot, handlers) =>
        new Promise<StagedInputInfo[]>((resolve) => {
          resolveStage = (infos) => {
            handlers.onPrepared?.(infos);
            resolve(infos);
          };
        }),
    );
    const { inputStagingSetter, romInputsSetter, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([rom])));
    expect(inputStagingSetter.value).toBe(true);
    // Pending row placed before staging resolves.
    expect(romInputsSetter.value).toHaveLength(1);
    expect((romInputsSetter.value[0] as { loading: boolean }).loading).toBe(true);

    await act(async () => {
      resolveStage([infoFor(rom, 0)]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inputStagingSetter.value).toBe(false);
    expect(romInputsSetter.value).toHaveLength(1);
    expect((romInputsSetter.value[0] as { loading: boolean }).loading).toBe(false);
  });

  it("reflects partial staging: one input resolved via onPrepared while another stays pending", async () => {
    const romA = source("a.bin");
    const romB = source("b.bin");
    let handlersRef: Parameters<NonNullable<LocalApplyPatchFormSessionOptions["stageInput"]>>[1] | undefined;
    const stageInput = vi.fn(
      (_snapshot, handlers) =>
        new Promise<StagedInputInfo[]>(() => {
          handlersRef = handlers;
        }),
    );
    const { romInputsSetter, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([romA, romB])));
    expect(romInputsSetter.value).toHaveLength(2);
    expect(romInputsSetter.value.every((row) => (row as { loading: boolean }).loading)).toBe(true);

    // Only romA finishes its prepare pass; onPrepared replaces the row set with just what it was
    // given, carrying real checksum info (vs the pending row's blank placeholder).
    act(() => handlersRef?.onPrepared?.([infoFor(romA, 0)]));
    const rows = romInputsSetter.value as Array<{ id: string; info: { crc32: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].info.crc32).toBe("aaaaaaaa");
  });

  it("guards concurrent stage runs: only the later generation's results win", async () => {
    const romOld = source("old.bin");
    const romNew = source("new.bin");
    let resolveFirst: (infos: StagedInputInfo[]) => void = () => undefined;
    let resolveSecond: (infos: StagedInputInfo[]) => void = () => undefined;
    let call = 0;
    const stageInput = vi.fn((_snapshot, handlers) => {
      call += 1;
      const isFirst = call === 1;
      return new Promise<StagedInputInfo[]>((resolve) => {
        const resolver = (infos: StagedInputInfo[]) => {
          handlers.onPrepared?.(infos);
          resolve(infos);
        };
        if (isFirst) resolveFirst = resolver;
        else resolveSecond = resolver;
      });
    });
    const { emitSessionTrace, romInputsSetter, result } = createHarness({ stageInput });

    // First stage run started (superseded before it resolves).
    act(() => result.current.staging.syncRomInput(snapshotOf([romOld])));
    // Second stage run started - a new file drop before the first settles.
    act(() => result.current.staging.syncRomInput(snapshotOf([romNew])));

    // Second (later) generation resolves first.
    await act(async () => {
      resolveSecond([infoFor(romNew, 0)]);
      await Promise.resolve();
    });
    expect(romInputsSetter.value).toHaveLength(1);
    expect((romInputsSetter.value[0] as { id: string }).id).toBe("new.bin");

    // First (stale) generation resolves last - must be ignored entirely.
    await act(async () => {
      resolveFirst([infoFor(romOld, 0)]);
      await Promise.resolve();
    });
    expect(romInputsSetter.value).toHaveLength(1);
    expect((romInputsSetter.value[0] as { id: string }).id).toBe("new.bin");
    expect(
      emitSessionTrace.mock.calls.some(
        ([message, details]) =>
          message === "stageInput complete ignored" && (details as { generation: number }).generation === 1,
      ),
    ).toBe(true);
  });

  it("swallows a workflow-disposed rejection silently (no onError, no setSectionErrorMessage)", async () => {
    const rom = source("rom.bin");
    let reject: (error: unknown) => void = () => undefined;
    const stageInput = vi.fn(
      () =>
        new Promise<StagedInputInfo[]>((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    const { onError, setSectionErrorMessage, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([rom])));
    await act(async () => {
      reject(disposedError());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(setSectionErrorMessage).not.toHaveBeenCalled();
  });

  it("reports a genuine (non-disposed) staging failure", async () => {
    const rom = source("rom.bin");
    let reject: (error: unknown) => void = () => undefined;
    const stageInput = vi.fn(
      () =>
        new Promise<StagedInputInfo[]>((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    const { onError, setSectionErrorMessage, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([rom])));
    await act(async () => {
      reject(new Error("boom"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(setSectionErrorMessage).toHaveBeenCalledWith("input", expect.objectContaining({ message: "boom" }));
  });

  it("does not crash and drops stale callbacks after the consuming component unmounts mid-stage", async () => {
    const rom = source("rom.bin");
    let reject: (error: unknown) => void = () => undefined;
    const stageInput = vi.fn(
      () =>
        new Promise<StagedInputInfo[]>((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    const { onError, setSectionErrorMessage, result, unmount } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([rom])));
    unmount();

    await expect(
      act(async () => {
        reject(disposedError());
        await Promise.resolve();
        await Promise.resolve();
      }),
    ).resolves.not.toThrow();

    expect(onError).not.toHaveBeenCalled();
    expect(setSectionErrorMessage).not.toHaveBeenCalled();
  });

  it("merges progress metadata and ignores progress without a source id", () => {
    const rom = source("game.zip");
    let handlersRef: Parameters<NonNullable<LocalApplyPatchFormSessionOptions["stageInput"]>>[1] | undefined;
    const stageInput = vi.fn((_snapshot, handlers) => {
      handlersRef = handlers;
      return new Promise<StagedInputInfo[]>(() => undefined);
    });
    const { emitSessionTrace, mergeRomInput, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([rom])));
    act(() => {
      handlersRef?.onProgress?.({
        details: { fileName: "game.zip", order: 0, stage: "extract" },
        label: "Extracting",
        percent: 20,
        stage: "input",
      });
      handlersRef?.onProgress?.({
        details: {
          fileName: "game.bin",
          is_rom: true,
          order: 0,
          probe_manifest: {
            disc_format: "CD",
            is_rom: true,
            platform: "Sony PlayStation",
            recommended_format: "chd",
          },
          sourceId: "game.zip",
          stage: "probe-manifest",
        },
        label: "Extracting game.bin",
        percent: 42,
        stage: "input",
      });
    });

    expect(mergeRomInput).toHaveBeenCalledTimes(1);
    expect(mergeRomInput.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ fileName: "game.bin", id: "game.zip", isRom: true, romType: expect.any(Object) }),
    );
    expect(mergeRomInput.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ progress: expect.objectContaining({ label: "Extracting game.bin" }) }),
    );
    expect(emitSessionTrace).toHaveBeenCalledWith(
      "stageInput progress ignored",
      expect.objectContaining({ reason: "missing-sourceId" }),
    );
  });

  it("reclassifies patch-only archives once and treats their teardown as expected", async () => {
    const archive = source("patches.zip");
    let handlersRef: Parameters<NonNullable<LocalApplyPatchFormSessionOptions["stageInput"]>>[1] | undefined;
    const stageInput = vi.fn((_snapshot, handlers) => {
      handlersRef = handlers;
      const error = new Error("archive moved") as Error & { details: { reclassifiedToPatch: boolean } };
      error.details = { reclassifiedToPatch: true };
      return Promise.reject(error);
    });
    const { emitSessionTrace, onError, reclassifyArchiveToPatch, result, setSectionErrorMessage } = createHarness({
      stageInput,
    });

    act(() => result.current.staging.syncRomInput(snapshotOf([archive])));
    act(() => {
      const progress = {
        details: {
          fileName: "patches.zip",
          order: 0,
          probe_manifest: { is_rom: false },
          sourceId: "patches.zip",
          stage: "probe-manifest",
        },
        label: "Inspecting patches.zip",
        percent: 10,
        stage: "input",
      } as const;
      handlersRef?.onProgress?.(progress);
      handlersRef?.onProgress?.(progress);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reclassifyArchiveToPatch).toHaveBeenCalledOnce();
    expect(reclassifyArchiveToPatch).toHaveBeenCalledWith(archive);
    expect(onError).not.toHaveBeenCalled();
    expect(setSectionErrorMessage).not.toHaveBeenCalled();
    expect(emitSessionTrace).toHaveBeenCalledWith("stageInput reclassified to patch bucket", expect.any(Object));
  });

  it("updates rows from checksum and state callbacks and ignores stale callbacks", () => {
    const first = source("first.bin");
    const second = source("second.bin");
    const handlers: Array<Parameters<NonNullable<LocalApplyPatchFormSessionOptions["stageInput"]>>[1]> = [];
    const stageInput = vi.fn((_snapshot, callbackHandlers) => {
      handlers.push(callbackHandlers);
      return new Promise<StagedInputInfo[]>(() => undefined);
    });
    const { emitSessionTrace, mergeRomInput, result } = createHarness({ stageInput });

    act(() => result.current.staging.syncRomInput(snapshotOf([first])));
    act(() => result.current.staging.syncRomInput(snapshotOf([second])));
    act(() => {
      handlers[0]?.onChecksum?.(infoFor(first, 0));
      handlers[0]?.onState?.(infoFor(first, 0));
      handlers[1]?.onChecksum?.(infoFor(second, 0));
      handlers[1]?.onState?.(infoFor(second, 0));
    });

    expect(mergeRomInput).toHaveBeenCalledTimes(2);
    expect(mergeRomInput.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ fileName: "second.bin" }));
    expect(emitSessionTrace).toHaveBeenCalledWith(
      "stageInput checksum ignored",
      expect.objectContaining({ reason: "stale-generation" }),
    );
    expect(emitSessionTrace).toHaveBeenCalledWith(
      "stageInput state ignored",
      expect.objectContaining({ reason: "stale-generation" }),
    );
  });
});

describe("useInputStaging syncPatchFiles", () => {
  it("resets patch staging state when there are no patches or no stagePatches handler", () => {
    const { patchStagingSetter, patchProgressSetter, patchProgressByKeySetter, result } = createPatchHarness();
    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [])));
    expect(patchStagingSetter.value).toBe(false);
    expect(patchProgressSetter.value).toBeNull();
    expect(patchProgressByKeySetter.value).toEqual({});
  });

  it("guards concurrent patch stage runs: only the later generation's info lands", async () => {
    const patchOld = source("old.ips");
    const patchNew = source("new.ips");
    let resolveFirst: (infos: StagedInputInfo[]) => void = () => undefined;
    let resolveSecond: (infos: StagedInputInfo[]) => void = () => undefined;
    let call = 0;
    const stagePatches = vi.fn(() => {
      call += 1;
      const isFirst = call === 1;
      return new Promise<StagedInputInfo[]>((resolve) => {
        if (isFirst) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const { patchInfoByKeySetter, result } = createPatchHarness({ stagePatches });

    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [patchOld])));
    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [patchNew])));

    await act(async () => {
      resolveSecond([{ fileName: "new.ips" }]);
      await Promise.resolve();
    });
    expect(patchInfoByKeySetter.value["new.ips"]).toBeTruthy();

    await act(async () => {
      resolveFirst([{ fileName: "old.ips" }]);
      await Promise.resolve();
    });
    // Stale (first-generation) resolution must not have clobbered the winning patch's info.
    expect(patchInfoByKeySetter.value["new.ips"]).toBeTruthy();
    expect(Object.keys(patchInfoByKeySetter.value)).toEqual(["new.ips"]);
  });

  it("swallows a workflow-disposed patch-staging rejection silently", async () => {
    const patch = source("a.ips");
    let reject: (error: unknown) => void = () => undefined;
    const stagePatches = vi.fn(
      () =>
        new Promise<StagedInputInfo[]>((_resolve, rejectFn) => {
          reject = rejectFn;
        }),
    );
    const { onError, setSectionErrorMessage, result } = createPatchHarness({ stagePatches });

    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [patch])));
    await act(async () => {
      reject(disposedError());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(setSectionErrorMessage).not.toHaveBeenCalled();
  });

  it("stages patch callbacks, preserves selected progress slots, and skips deferred validation after expansion", async () => {
    const patchA = source("a.ips");
    const patchB = source("b.ips");
    let handlersRef: Parameters<NonNullable<LocalApplyPatchFormSessionOptions["stagePatches"]>>[1] | undefined;
    const stagePatches = vi.fn((_snapshot, handlers) => {
      handlersRef = handlers;
      handlers.onImplicitPatches?.([patchA, patchB], [infoFor(patchA, 0), infoFor(patchB, 1)]);
      handlers.onPatchStaged?.(infoFor(patchA, 0), 0);
      handlers.onProgress?.({
        details: { order: 1 },
        label: "Reading b.ips",
        percent: 30,
        stage: "input",
      });
      return Promise.resolve([infoFor(patchA, 0), infoFor(patchB, 1)]);
    });
    const { patchInfoByKeySetter, patchProgressByKeySetter, patchStagingSetter, result } = createPatchHarness({
      stagePatches,
      validatePatches: vi.fn(),
    });

    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [patchA, patchB]), { freshIndices: new Set([1]) }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchStagingSetter.value).toBe(false);
    expect(patchInfoByKeySetter.value).toEqual(
      expect.objectContaining({ "a.ips": expect.objectContaining({ fileName: "a.ips" }) }),
    );
    expect(patchInfoByKeySetter.value["b.ips"]).toEqual(expect.objectContaining({ fileName: "b.ips" }));
    expect(patchProgressByKeySetter.value).toEqual({});
    expect(handlersRef).toBeTruthy();
  });

  it("reports non-disposed patch staging failures and supports silent staging", async () => {
    const patch = source("broken.ips");
    const stagePatches = vi.fn().mockRejectedValue(new Error("patch staging failed"));
    const { onError, setSectionErrorMessage, result } = createPatchHarness({ stagePatches });

    act(() => result.current.staging.syncPatchFiles(snapshotOf([], [patch])));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "patch staging failed" }));
    expect(setSectionErrorMessage).toHaveBeenCalledWith(
      "patch",
      expect.objectContaining({ message: "patch staging failed" }),
    );

    const silentStage = vi.fn().mockResolvedValue([infoFor(patch, 0)]);
    const silentHarness = createPatchHarness({ stagePatches: silentStage });
    act(() => silentHarness.result.current.staging.syncPatchFiles(snapshotOf([], [patch]), { silent: true }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(silentHarness.patchStagingSetter.value).toBe(false);
    expect(silentHarness.patchProgressSetter.value).toBeNull();
  });
});

describe("useInputStaging validatePatchesDeferred", () => {
  it("merges verdicts back onto patch infos when validation resolves", async () => {
    const patch = source("a.ips");
    const validatePatches = vi.fn(async () => [{ fileName: "a.ips", validationState: "valid" }]);
    const { patchInfoByKeySetter, result } = createPatchHarness({ validatePatches });

    await act(async () => {
      // No explicit generation: defaults to the machine's current stage generation, matching how
      // validatePatchesDeferred is invoked in production (right after a stage run completes).
      result.current.staging.validatePatchesDeferred(snapshotOf([], [patch]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchInfoByKeySetter.value["a.ips"]).toEqual(expect.objectContaining({ validationState: "valid" }));
  });

  it("does nothing when there is no validatePatches handler", () => {
    const patch = source("a.ips");
    const { patchInfoByKeySetter, result } = createPatchHarness();
    act(() => result.current.staging.validatePatchesDeferred(snapshotOf([], [patch]), 1));
    expect(patchInfoByKeySetter.value).toEqual({});
  });

  it("swallows a workflow-disposed validation rejection silently, without marking rows invalid", async () => {
    const patch = source("a.ips");
    const validatePatches = vi.fn(async () => {
      throw disposedError();
    });
    const { onError, patchInfoByKeySetter, setSectionErrorMessage, result } = createPatchHarness({
      validatePatches,
    });
    // Seed a "verifying" row so we could observe a failVerifyingPatches side effect if the guard failed.
    act(() => {
      result.current.staging.syncPatchFiles(snapshotOf([], []));
    });

    await act(async () => {
      // Omit generationArg so it matches the machine's actual current generation - otherwise the
      // stale-generation guard would return before ever reaching the isWorkflowDisposedError check,
      // and this test would pass for the wrong reason.
      result.current.staging.validatePatchesDeferred(snapshotOf([], [patch]));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).not.toHaveBeenCalled();
    expect(setSectionErrorMessage).not.toHaveBeenCalled();
    expect(patchInfoByKeySetter.value).toEqual({});
  });

  it("stale generation guard: an outdated validation result is dropped", async () => {
    const patch = source("a.ips");
    let resolveValidate: (infos: StagedInputInfo[]) => void = () => undefined;
    const validatePatches = vi.fn(
      () =>
        new Promise<StagedInputInfo[]>((resolve) => {
          resolveValidate = resolve;
        }),
    );
    const { patchInfoByKeySetter, result } = createPatchHarness({ validatePatches });

    // generationArg = 999 will never match the real current generation (starts at 0/1), so the
    // resolved verdict must never be merged in.
    act(() => {
      result.current.staging.validatePatchesDeferred(snapshotOf([], [patch]), 999);
    });
    await act(async () => {
      resolveValidate([{ fileName: "a.ips", validationState: "valid" }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchInfoByKeySetter.value).toEqual({});
  });

  it("marks verifying patches invalid when deep validation fails", async () => {
    const patch = source("a.ips");
    const validatePatches = vi.fn().mockRejectedValue(new Error("validation failed"));
    const harness = createPatchHarness({ validatePatches });
    act(() => {
      harness.patchInfoByKeySetter.spy({
        "a.ips": { fileName: "a.ips", validationState: "verifying" } as StagedInputInfo,
      });
      harness.result.current.staging.validatePatchesDeferred(snapshotOf([], [patch]));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.patchInfoByKeySetter.value["a.ips"]).toEqual(
      expect.objectContaining({ validationMessage: "validation failed", validationState: "invalid" }),
    );
    expect(harness.onError).not.toHaveBeenCalled();
    expect(harness.setSectionErrorMessage).not.toHaveBeenCalled();
  });
});
