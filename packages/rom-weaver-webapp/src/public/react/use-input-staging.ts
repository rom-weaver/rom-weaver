import { type MutableRefObject, useMemo } from "react";
import {
  createRomInputRow,
  getChecksumProgressInfoPatch,
  getPendingInputDisplayFileName,
  getProgressDetails,
  getProgressStagedInputInfo,
  isCompressedInputFileName,
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

// A patch-only archive that was optimistically staged in the ROM bucket throws this (carrying the
// `reclassifiedToPatch` detail) once its descent surfaces patch leaves but no ROM payload, so the ROM
// staging tears down and the is_rom=false progress it emitted re-homes it into the patch bucket.
const isArchiveReclassifiedToPatchError = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  (error as { details?: { reclassifiedToPatch?: unknown } }).details?.reclassifiedToPatch === true;

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
    /** Move a staged archive out of the ROM bucket into the patch bucket - invoked when Rust's
     * probe-manifest identifies it as a patch-only container (`is_rom === false`). */
    reclassifyArchiveToPatch: (source: BinarySource) => void;
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
    validatePatches?: LocalApplyPatchFormSessionOptions["validatePatches"];
  };
}

// Owns the imperative input/patch staging routines that populate ROM rows and patch info from the
// staging workflow, including the stage-generation guarding that drops results from superseded runs.
// Returns stable functions driven by the parent's input/patch/settings effects.
const useInputStaging = (context: InputStagingContext) => {
  const contextRef = useLatestRef(context);
  return useMemo(() => {
    const failVerifyingPatches = (snapshot: ApplyWorkflowStageSnapshot, error: Error) => {
      const { getPatchKey } = contextRef.current.rows;
      contextRef.current.session.setPatchInfoByKey((current) => {
        const next = { ...current };
        for (const patch of snapshot.patches) {
          const key = getPatchKey(patch, snapshot.patches);
          const info = next[key];
          if (info?.validationState === "verifying") {
            next[key] = { ...info, validationMessage: error.message, validationState: "invalid" };
          }
        }
        return next;
      });
    };

    // Run the deep dry-run patch validation that was deferred out of staging (so the card could show
    // its info + cheap preflight verdict instantly) and merge the refreshed verdicts back onto the
    // already-visible patch rows, showing a "Validating…" indicator per row while it runs.
    const validatePatchesDeferred = (snapshot: ApplyWorkflowStageSnapshot, generationArg?: number) => {
      const { machines, rows, session, stage } = contextRef.current;
      const patchStageGenerationRef = machines.patchStageMachine.stageGenerationRef;
      const generation = generationArg ?? patchStageGenerationRef.current;
      const { getPatchKey } = rows;
      const { setPatchInfoByKey } = session;
      const { validatePatches } = stage;
      if (!(validatePatches && snapshot.patches.length)) return;
      const mergeInfos = (infos: Array<StagedInputInfo | null | undefined>) => {
        if (patchStageGenerationRef.current !== generation) return;
        setPatchInfoByKey((current) => {
          const next = { ...current };
          snapshot.patches.forEach((patch, index) => {
            const info = infos[index];
            if (info) next[getPatchKey(patch, snapshot.patches)] = info;
          });
          return next;
        });
      };
      // Run silently: the card already shows its info + preflight and reads as settled, so the deep
      // dry-run must NOT re-emit staging progress (that would drop the row back into the shimmer and
      // make the patch look like it is hanging again - the whole point of the deferral). The card
      // shows "Verifying…" (pre-validation infos, target resolved + verdict pending) while it runs;
      // only the verdict is merged when it lands.
      void validatePatches(snapshot, mergeInfos)
        .then(mergeInfos)
        .catch((error) => {
          if (patchStageGenerationRef.current !== generation) return;
          const normalized = toError(error);
          if (isWorkflowDisposedError(normalized)) return;
          failVerifyingPatches(snapshot, normalized);
          logUiError("Patch validation failed", normalized);
        });
    };

    const syncPatchFiles = (
      snapshot: ApplyWorkflowStageSnapshot,
      options: {
        silent?: boolean;
        /** Index of the first newly-added patch; earlier patches keep their staged cards. */
        freshFromIndex?: number;
        /** Exact set of re-staged slots (a single in-place replace); every other card keeps its
         * resolved state, so only these indices shimmer. Takes precedence over `freshFromIndex`. */
        freshIndices?: ReadonlySet<number>;
      } = {},
    ) => {
      const { machines, report, rows, session, stage } = contextRef.current;
      const { patchStageMachine } = machines;
      const patchStageGenerationRef = patchStageMachine.stageGenerationRef;
      const { getPatchKey, updatePatches } = rows;
      const { setPatchInfoByKey, setPatchProgress, setPatchProgressByKey, setPatchStaging } = session;
      const { setSectionErrorMessage, onError } = report;
      const { stagePatches } = stage;
      const generation = patchStageMachine.nextStageGeneration();
      let expandedPatchSources = false;
      if (!(snapshot.patches.length && stagePatches)) {
        setPatchStaging(false);
        setPatchProgress(null);
        setPatchProgressByKey({});
        return;
      }
      const silent = options.silent === true;
      // Patches before this index are already staged in OPFS; only the appended tail
      // shows progress so their resolved cards stay put instead of flashing "Waiting".
      const freshFromIndex = Math.max(0, Math.min(options.freshFromIndex ?? 0, snapshot.patches.length));
      // A single in-place replace re-stages only its slot; every other card keeps its resolved state.
      const { freshIndices } = options;
      const isFreshIndex = (index: number) => (freshIndices ? freshIndices.has(index) : index >= freshFromIndex);
      const firstFreshIndex = freshIndices
        ? snapshot.patches.findIndex((_patch, index) => freshIndices.has(index))
        : freshFromIndex;
      const preserveExistingProgress = freshIndices ? true : freshFromIndex > 0;
      const initialProgress = {
        indeterminate: true,
        label: "Preparing patch...",
        message: "Preparing patch...",
      };
      if (!silent) {
        setPatchStaging(true);
        setPatchProgress(null);
        setPatchProgressByKey((current) => {
          const next = preserveExistingProgress ? { ...current } : {};
          snapshot.patches.forEach((patch, index) => {
            if (!isFreshIndex(index)) return;
            next[getPatchKey(patch, snapshot.patches)] =
              index === firstFreshIndex ? initialProgress : createWaitingWorkflowProgress();
          });
          return next;
        });
      }
      void stagePatches(snapshot, {
        // A nested patch archive can fan out into several leaf patches; grow the React patch stack
        // to N independent sources so every selected patch shows as its own row (mirrors inputs).
        onImplicitPatches: (patches, infos = []) => {
          if (patchStageGenerationRef.current !== generation) return;
          expandedPatchSources = true;
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
        // The patch finished its eager parse while the ROM is still staging. Surface its parsed info
        // (format/name/requirements) and drop its staging progress so the card leaves "Reading…" the
        // moment the patch is read - the ROM keeps staging, and the deferred dry-run flips the card to
        // "Verifying…" once the ROM lands.
        onPatchStaged: (info, order) => {
          if (patchStageGenerationRef.current !== generation) return;
          const patch = snapshot.patches[order];
          if (!(patch && info)) return;
          const key = getPatchKey(patch, snapshot.patches);
          setPatchInfoByKey((current) => ({ ...current, [key]: info }));
          if (silent) return;
          setPatchProgressByKey((current) => {
            if (!(key in current)) return current;
            const next = { ...current };
            delete next[key];
            return next;
          });
        },
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
          // The card now shows info + cheap preflight; run the deferred deep validation silently in
          // the background so it no longer makes the patch look like it is hanging.
          if (!expandedPatchSources) validatePatchesDeferred(snapshot, generation);
        })
        .catch((error) => {
          if (patchStageGenerationRef.current !== generation) return;
          const normalizedError = toError(error);
          if (isWorkflowDisposedError(normalizedError)) return;
          failVerifyingPatches(snapshot, normalizedError);
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
      const { inputStageMachine, patchStageMachine } = machines;
      const inputStageGenerationRef = inputStageMachine.stageGenerationRef;
      const inputProgressGenerationRef = inputStageMachine.progressGenerationRef;
      const patchStageGeneration = patchStageMachine.stageGenerationRef.current;
      const { busyRef, disabledRef } = refs;
      const { emitSessionTrace, onError, setSectionErrorMessage } = report;
      const { getInputKey, getPatchKey, getStableInputInfo, mergeRomInput, reclassifyArchiveToPatch, updatePatches } =
        rows;
      const { setInputStaging, setPatchInfoByKey, setRomInputs } = session;
      const { stageInput } = stage;
      const { generation, progressGeneration } = inputStageMachine.nextRunGeneration();
      // An archive Rust identifies as patch-only (`is_rom === false`) is moved to the patch bucket once;
      // the move supersedes this run, so a per-run guard is enough to fire a single reclassify.
      const reclassifiedInputKeys = new Set<string>();
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
      const resolveRowInfo = (info: StagedInputInfo) => getStableInputInfo(info, snapshot.inputs);
      const replaceRomInputs = (infos: StagedInputInfo[], finalized: boolean) => {
        setRomInputs((current) => {
          const byId = new Map(current.map((entry) => [entry.id, entry]));
          return sortRomInputs(
            infos.map((rawInfo, index) => {
              const info = resolveRowInfo(rawInfo);
              const id = info.id || getInputKey(snapshot.inputs[index] as BinarySource, snapshot.inputs);
              const existing = byId.get(id) || current.find((entry) => entry.order === (info.order ?? index));
              return createRomInputRow({
                ...existing,
                archivePathEntries: info.parentCompressions ?? existing?.archivePathEntries,
                chdMode: info.chdMode ?? existing?.chdMode,
                cueText: info.cueText ?? existing?.cueText,
                disabled: finalized ? disabledRef.current || busyRef.current : true,
                gdiText: info.gdiText ?? existing?.gdiText,
                groupId: info.groupId ?? existing?.groupId,
                id,
                info: {
                  archiveName: info.archiveName || existing?.info.archiveName || "",
                  checksumTiming: info.checksumTiming || existing?.info.checksumTiming || "",
                  checksumVariants: info.checksumVariants ?? existing?.info.checksumVariants,
                  crc32: info.checksums?.crc32 || existing?.info.crc32 || "",
                  fileName: info.fileName || existing?.info.fileName || `Input ${index + 1}`,
                  md5: info.checksums?.md5 || existing?.info.md5 || "",
                  romProbe: info.romProbe ?? existing?.info.romProbe,
                  romType: info.romType ?? existing?.info.romType,
                  sha1: info.checksums?.sha1 || existing?.info.sha1 || "",
                  validationPhase: finalized ? "idle" : existing?.info.validationPhase || "idle",
                },
                kind: info.kind ?? existing?.kind,
                loading: !finalized,
                order: info.order ?? index,
                patchable: info.patchable ?? existing?.patchable,
                progress: finalized
                  ? null
                  : existing?.progress || (index ? createWaitingWorkflowProgress() : initialProgress),
                size: info.size ?? existing?.size,
                sourceSize: info.sourceSize ?? existing?.sourceSize,
                splitBinAvailable: info.splitBinAvailable ?? existing?.splitBinAvailable,
                valid: finalized,
                wasDecompressed: info.wasDecompressed ?? existing?.wasDecompressed,
              });
            }),
          );
        });
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
                // A dropped container extracts before/while it hashes, so seed the extract
                // phase up front - the card reads "Extracting & Checksumming…" from the first
                // frame instead of flashing a bare "Checksumming…" until the first extract
                // event lands. A real phase already observed (extract/checksum) wins; the seed
                // only overrides the "idle" default, and a bare ROM stays "idle" → "Checksumming…".
                validationPhase:
                  existing?.info.validationPhase === "extract" || existing?.info.validationPhase === "checksum"
                    ? existing.info.validationPhase
                    : isCompressedInputFileName(getBinarySourceFileName(input, ""))
                      ? "extract"
                      : existing?.info.validationPhase,
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
          mergeRomInput(resolveRowInfo(info), {
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
        onPrepared: (infos) => {
          if (inputStageGenerationRef.current !== generation) return;
          emitSessionTrace("stageInput prepared", { generation, infoCount: infos.length });
          replaceRomInputs(infos, false);
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
          const info = resolveRowInfo(getProgressStagedInputInfo(event));
          const source = typeof info.order === "number" ? snapshot.inputs[info.order] : undefined;
          // Rust's probe-manifest identified this archive as a patch-only container - move it to the
          // patch bucket instead of dead-ending the ROM extract. The move re-stages without this source
          // (superseding this run), and the patch bucket's extract-all fans the bundle's patches out.
          if (source && info.isRom === false) {
            const inputKey = getInputKey(source, snapshot.inputs);
            if (!reclassifiedInputKeys.has(inputKey)) {
              reclassifiedInputKeys.add(inputKey);
              emitSessionTrace("stageInput reclassify archive to patch bucket", {
                fileName: info.fileName,
                generation,
                order: info.order,
                sourceId,
              });
              reclassifyArchiveToPatch(source);
            }
            return;
          }
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
          // Surface a clean "Extracting <name>" label for the extraction stage
          // (the runtime emits an internal VFS path like "preparing extraction
          // for `/work/x.chd`"); leave read/checksum stage labels untouched.
          const extractLabel =
            info.fileName && /extract/i.test(String(event.label || "")) ? `Extracting ${info.fileName}` : undefined;
          mergeRomInput(info, {
            ...getChecksumProgressInfoPatch(details),
            progress: toInputProgress(extractLabel ? { ...event, label: extractLabel } : event),
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
          mergeRomInput(resolveRowInfo(info), {
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
          replaceRomInputs(infos, true);
          // The ROM is now staged and the controller has resolved each patch's target, so run the
          // deferred deep validation. This is the race-free trigger for a patch dropped BEFORE its
          // ROM: the card flips to "Verifying…" the moment the ROM lands, then shows the verdict.
          // A same-tick patch staging run owns validation for the shared snapshot. Without this guard,
          // ROM and patch completion each queued the same silent validation (and re-extracted archives).
          if (snapshot.patches.length && patchStageMachine.stageGenerationRef.current === patchStageGeneration) {
            validatePatchesDeferred(snapshot);
          }
        })
        .catch((error) => {
          const normalizedError = toError(error);
          if (isWorkflowDisposedError(normalizedError)) return;
          // A patch-only archive optimistically staged in the ROM bucket aborts its ROM staging so the
          // reclassify (driven by the is_rom=false progress it already emitted) can re-home it to the
          // patch bucket. That teardown is expected, not a failure - do not surface it.
          if (isArchiveReclassifiedToPatchError(normalizedError)) {
            emitSessionTrace("stageInput reclassified to patch bucket", { generation });
            return;
          }
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

    return { syncPatchFiles, syncRomInput, validatePatchesDeferred };
  }, [contextRef]);
};

export { useInputStaging };
