import { type MutableRefObject, useMemo } from "react";
import {
  createRomInputRow,
  getChecksumProgressInfoPatch,
  getPendingInputDisplayFileName,
  getProgressDetails,
  getProgressStagedInputInfo,
  sortRomInputs,
} from "./apply-session-inputs.ts";
import { getTraceSourceSummaries, logUiError } from "./apply-session-logging.ts";
import type { StageGenerationMachine } from "./apply-session-staging-state-machine.ts";
import type { useLocalPatcherSessionState } from "./apply-session-state.ts";
import type {
  ApplyWorkflowStageSnapshot,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "./apply-session-types.ts";
import { getBinarySourceFileName, toInputProgress } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import { isWorkflowDisposedError, toError } from "./patcher-form-session-utils.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import { useLatestRef } from "./use-latest-ref.ts";
import { createWaitingWorkflowProgress } from "./workflow-run-hooks.ts";

type SessionState = ReturnType<typeof useLocalPatcherSessionState>;
type RomInputPatch = Omit<Partial<RomInputRowState>, "info"> & { info?: Partial<RomInputRowState["info"]> };

interface InputStagingContext {
  machines: {
    inputStageMachine: StageGenerationMachine;
    patchStageMachine: StageGenerationMachine;
  };
  refs: {
    busyRef: MutableRefObject<boolean>;
    disabledRef: MutableRefObject<boolean>;
  };
  report: {
    emitSessionTrace: (message: string, details?: Record<string, unknown>) => void;
    onError?: (error: Error) => void;
    setSectionErrorMessage: (placement: "input" | "output" | "patch", error: Error) => void;
  };
  rows: {
    getInputKey: (source: BinarySource, sources?: BinarySource[]) => string;
    getPatchKey: (source: BinarySource, sources?: BinarySource[]) => string;
    getStableInputInfo: (info: StagedInputInfo, sources: BinarySource[]) => StagedInputInfo;
    mergeRomInput: (info: StagedInputInfo, patch?: RomInputPatch) => void;
    updatePatches: (nextPatches: BinarySource[]) => void;
  };
  session: Pick<
    SessionState,
    | "setInputStaging"
    | "setPatchInfoByKey"
    | "setPatchProgress"
    | "setPatchProgressByKey"
    | "setPatchStaging"
    | "setRomInputs"
  >;
  stage: {
    stageInput?: LocalApplyPatchFormSessionOptions["stageInput"];
    stagePatches?: LocalApplyPatchFormSessionOptions["stagePatches"];
  };
}

// Owns the imperative input/patch staging routines that populate ROM rows and patch info from the
// staging workflow, including the stage-generation guarding that drops results from superseded runs.
// Returns stable functions driven by the parent's input/patch/settings effects.
const useInputStaging = (context: InputStagingContext) => {
  const contextRef = useLatestRef(context);
  return useMemo(() => {
    const syncPatchFiles = (
      snapshot: ApplyWorkflowStageSnapshot,
      options: {
        silent?: boolean;
      } = {},
    ) => {
      const { machines, report, rows, session, stage } = contextRef.current;
      const { patchStageMachine } = machines;
      const patchStageGenerationRef = patchStageMachine.stageGenerationRef;
      const { getPatchKey } = rows;
      const { setPatchInfoByKey, setPatchProgress, setPatchProgressByKey, setPatchStaging } = session;
      const { setSectionErrorMessage, onError } = report;
      const { stagePatches } = stage;
      const generation = patchStageMachine.nextStageGeneration();
      if (!(snapshot.patches.length && stagePatches)) {
        setPatchStaging(false);
        setPatchProgress(null);
        setPatchProgressByKey({});
        return;
      }
      const silent = options.silent === true;
      const initialProgress = {
        indeterminate: true,
        label: "Preparing patch...",
        message: "Preparing patch...",
      };
      if (!silent) {
        setPatchStaging(true);
        setPatchProgress(null);
        setPatchProgressByKey(
          Object.fromEntries(
            snapshot.patches.map((patch, index) => [
              getPatchKey(patch, snapshot.patches),
              index === 0 ? initialProgress : createWaitingWorkflowProgress(),
            ]),
          ),
        );
      }
      void stagePatches(snapshot, {
        onProgress: (event) => {
          if (silent) return;
          if (patchStageGenerationRef.current !== generation) return;
          const details = getProgressDetails(event);
          const order = typeof details.order === "number" ? details.order : -1;
          const patch = (order >= 0 ? snapshot.patches[order] : undefined) || snapshot.patches[0] || null;
          if (!patch) {
            setPatchProgress(toInputProgress(event));
            return;
          }
          const key = getPatchKey(patch, snapshot.patches);
          setPatchProgressByKey((current) => ({
            ...current,
            [key]: toInputProgress(event),
          }));
        },
      })
        .then((infos) => {
          if (patchStageGenerationRef.current !== generation) return;
          setPatchInfoByKey(
            Object.fromEntries(
              snapshot.patches.map((patch, index) => [
                getPatchKey(patch, snapshot.patches),
                infos[index] || { fileName: getBinarySourceFileName(patch, `Patch ${index + 1}`) },
              ]),
            ),
          );
        })
        .catch((error) => {
          if (patchStageGenerationRef.current !== generation) return;
          const normalizedError = toError(error);
          if (isWorkflowDisposedError(normalizedError)) return;
          logUiError("Patch staging failed", normalizedError);
          setSectionErrorMessage("patch", normalizedError);
          onError?.(normalizedError);
        })
        .finally(() => {
          if (patchStageGenerationRef.current !== generation) return;
          if (!silent) {
            setPatchStaging(false);
            setPatchProgress(null);
            setPatchProgressByKey({});
          }
        });
    };

    const syncRomInput = (snapshot: ApplyWorkflowStageSnapshot, previousInputs: BinarySource[] = []) => {
      const { machines, refs, report, rows, session, stage } = contextRef.current;
      const { inputStageMachine } = machines;
      const inputStageGenerationRef = inputStageMachine.stageGenerationRef;
      const inputProgressGenerationRef = inputStageMachine.progressGenerationRef;
      const { busyRef, disabledRef } = refs;
      const { emitSessionTrace, onError, setSectionErrorMessage } = report;
      const { getInputKey, getPatchKey, getStableInputInfo, mergeRomInput, updatePatches } = rows;
      const { setInputStaging, setPatchInfoByKey, setRomInputs } = session;
      const { stageInput } = stage;
      const { generation, progressGeneration } = inputStageMachine.nextRunGeneration();
      const retainedInputKeys = new Set(previousInputs.map((input) => getInputKey(input, previousInputs)));
      emitSessionTrace("input staging sync started", {
        generation,
        hasStageInput: !!stageInput,
        inputCount: snapshot.inputs.length,
        patchCount: snapshot.patches.length,
        previousCount: previousInputs.length,
        progressGeneration,
        retainedCount: retainedInputKeys.size,
        sources: getTraceSourceSummaries(snapshot.inputs, "Input"),
      });
      if (!(snapshot.inputs[0] && stageInput)) {
        emitSessionTrace("input staging sync skipped", {
          generation,
          hasFirstInput: !!snapshot.inputs[0],
          hasStageInput: !!stageInput,
        });
        setInputStaging(false);
        setRomInputs([]);
        return;
      }
      setInputStaging(true);
      const initialProgress = {
        indeterminate: true,
        label: "Preparing input...",
        message: "Preparing input...",
      };
      setRomInputs((current) =>
        sortRomInputs(
          snapshot.inputs.map((input, index) => {
            const id = getInputKey(input, snapshot.inputs);
            const existing = current.find((entry) => entry.id === id) || current.find((entry) => entry.order === index);
            const existingProgress = existing?.progress || null;
            const retained = retainedInputKeys.has(id);
            const isQueued = index > 0 || retainedInputKeys.size > 0;
            return createRomInputRow({
              ...existing,
              disabled: true,
              id,
              info: {
                ...existing?.info,
                archiveName: existing?.info.archiveName || "",
                fileName: existing?.info.fileName || getPendingInputDisplayFileName(input, `Input ${index + 1}`),
              },
              loading: retained && existing ? existing.loading : true,
              order: index,
              progress:
                existingProgress ||
                (retained && existing ? null : isQueued ? createWaitingWorkflowProgress() : initialProgress),
              valid: retained && existing ? existing.valid : false,
            });
          }),
        ),
      );
      emitSessionTrace("stageInput dispatched", {
        generation,
        inputCount: snapshot.inputs.length,
        progressGeneration,
      });
      void stageInput(snapshot, {
        onChecksum: (info) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput checksum ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput checksum", {
            fileName: info.fileName,
            hasChecksums: !!info.checksums,
            order: info.order,
            size: info.size,
            sourceSize: info.sourceSize,
          });
          mergeRomInput(getStableInputInfo(info, snapshot.inputs), {
            disabled: true,
            info: { validationPhase: "idle" },
            loading: false,
            progress: null,
            valid: true,
          });
        },
        onImplicitPatches: (patches, infos = []) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput implicit patches ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          if (!patches.length) return;
          emitSessionTrace("stageInput implicit patches", {
            generation,
            patchCount: patches.length,
            patches: patches.map((patch, index) => getBinarySourceFileName(patch, `Patch ${index + 1}`)),
          });
          updatePatches(patches);
          setPatchInfoByKey(
            Object.fromEntries(
              patches.map((patch, index) => [
                getPatchKey(patch, patches),
                infos[index] || { fileName: getBinarySourceFileName(patch, `Patch ${index + 1}`) },
              ]),
            ),
          );
        },
        onProgress: (event) => {
          const details = getProgressDetails(event);
          if (
            inputStageGenerationRef.current !== generation ||
            inputProgressGenerationRef.current !== progressGeneration
          ) {
            emitSessionTrace("stageInput progress ignored", {
              currentGeneration: inputStageGenerationRef.current,
              currentProgressGeneration: inputProgressGenerationRef.current,
              generation,
              progress: {
                fileName: details.fileName,
                order: details.order,
                percent: event.percent,
                sourceId: details.sourceId,
                stage: details.stage,
              },
              progressGeneration,
              reason: "stale-generation",
            });
            return;
          }
          const sourceId = typeof details.sourceId === "string" ? details.sourceId : "";
          if (!sourceId) {
            emitSessionTrace("stageInput progress ignored", {
              generation,
              progress: {
                fileName: details.fileName,
                order: details.order,
                percent: event.percent,
                stage: details.stage,
              },
              progressGeneration,
              reason: "missing-sourceId",
            });
            return;
          }
          const info = getStableInputInfo(getProgressStagedInputInfo(event), snapshot.inputs);
          const source = typeof info.order === "number" ? snapshot.inputs[info.order] : undefined;
          if (source && retainedInputKeys.has(getInputKey(source, snapshot.inputs))) {
            emitSessionTrace("stageInput progress ignored", {
              generation,
              order: info.order,
              progressGeneration,
              reason: "retained-input",
              sourceId,
            });
            return;
          }
          emitSessionTrace("stageInput progress", {
            fileName: info.fileName,
            generation,
            order: info.order,
            percent: event.percent,
            progressGeneration,
            sourceId,
            stage: details.stage,
          });
          mergeRomInput(info, {
            ...getChecksumProgressInfoPatch(details),
            progress: toInputProgress(event),
          });
        },
        onState: (info) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput state ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput state", {
            fileName: info.fileName,
            generation,
            order: info.order,
            size: info.size,
            sourceSize: info.sourceSize,
          });
          mergeRomInput(getStableInputInfo(info, snapshot.inputs), {
            disabled: true,
            info: { validationPhase: "idle" },
            loading: false,
            progress: null,
            valid: !!info.fileName,
          });
        },
      })
        .then((infos) => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput complete ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              infoCount: infos.length,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput complete", {
            generation,
            infoCount: infos.length,
            infos: infos.map((info) => ({
              fileName: info.fileName,
              order: info.order,
              size: info.size,
              sourceSize: info.sourceSize,
              wasDecompressed: info.wasDecompressed,
            })),
          });
          setRomInputs((current) => {
            const byId = new Map(current.map((entry) => [entry.id, entry]));
            return sortRomInputs(
              infos.map((rawInfo, index) => {
                const info = getStableInputInfo(rawInfo, snapshot.inputs);
                const stableId = info.id || getInputKey(snapshot.inputs[index] as BinarySource, snapshot.inputs);
                return createRomInputRow({
                  ...(stableId ? byId.get(stableId) : undefined),
                  chdMode: info.chdMode ?? byId.get(stableId)?.chdMode,
                  disabled: disabledRef.current || busyRef.current,
                  id: stableId,
                  info: {
                    archiveName: info.archiveName || "",
                    checksumTiming: info.checksumTiming || byId.get(stableId)?.info.checksumTiming || "",
                    crc32: info.checksums?.crc32 || "",
                    fileName: info.fileName || getBinarySourceFileName(snapshot.inputs[index], `Input ${index + 1}`),
                    md5: info.checksums?.md5 || "",
                    romProbe: info.romProbe || byId.get(stableId)?.info.romProbe,
                    sha1: info.checksums?.sha1 || "",
                    validationPhase: "idle",
                  },
                  kind: info.kind,
                  loading: false,
                  order: info.order ?? index,
                  progress: null,
                  size: info.size,
                  sourceSize: info.sourceSize,
                  splitBinAvailable: info.splitBinAvailable,
                  valid: true,
                  wasDecompressed: info.wasDecompressed,
                });
              }),
            );
          });
        })
        .catch((error) => {
          const normalizedError = toError(error);
          if (isWorkflowDisposedError(normalizedError)) return;
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput failure ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              message: normalizedError.message,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput failed", {
            generation,
            message: normalizedError.message,
            name: normalizedError.name,
          });
          logUiError("Input staging failed", normalizedError);
          setSectionErrorMessage("input", normalizedError);
          onError?.(normalizedError);
        })
        .finally(() => {
          if (inputStageGenerationRef.current !== generation) {
            emitSessionTrace("stageInput finalizer ignored", {
              currentGeneration: inputStageGenerationRef.current,
              generation,
              reason: "stale-generation",
            });
            return;
          }
          emitSessionTrace("stageInput finalizer", {
            generation,
          });
          setInputStaging(false);
          setRomInputs((current) =>
            current.map((entry) =>
              createRomInputRow({
                ...entry,
                disabled: disabledRef.current || busyRef.current,
                info: { ...entry.info, validationPhase: "idle" },
                loading: false,
                progress: null,
              }),
            ),
          );
        });
    };

    return { syncPatchFiles, syncRomInput };
  }, [contextRef]);
};

export type { InputStagingContext };
export { useInputStaging };
