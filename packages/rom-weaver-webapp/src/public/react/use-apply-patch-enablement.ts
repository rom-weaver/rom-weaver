import { useCallback, useRef, useState } from "react";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";

/**
 * Owns the apply form's patch enable/disable state (the loom On/Off switch).
 * Disabled patches stay on the bench but are excluded from the apply run; the
 * set is keyed by stable patch-slot id so replacements/reorders keep the right patches
 * off. Extracted from `ApplyPatchForm` as a cohesive state+refs+callback group:
 *
 * - `disabledPatchIds` / `togglePatchEnabled` drive the per-patch switch.
 * - `seedPatchEnablement` carries a bundle session's default on/off state.
 * - `syncPatchTracking` mirrors the current patch list into stable patch slots
 *   (so replacement at an index keeps its metadata and toggle state) and drops
 *   stale toggles whenever a slot is removed.
 * - `filterEnabledPatchRun` strips disabled patches (and their index-aligned
 *   per-patch run options) before they reach the workflow; `getPatchIds`
 *   feeds the view's enablement controls.
 */
const useApplyPatchEnablement = () => {
  const [disabledPatchIds, setDisabledPatchIds] = useState<ReadonlySet<string>>(new Set());
  const disabledPatchIdsRef = useRef(disabledPatchIds);
  disabledPatchIdsRef.current = disabledPatchIds;
  const currentPatchesRef = useRef<BinarySource[]>([]);
  const patchSlotIdsRef = useRef<string[]>([]);
  const nextSlotIdRef = useRef(0);

  const newSlotId = useCallback(() => {
    nextSlotIdRef.current += 1;
    return `patch-slot-${nextSlotIdRef.current}`;
  }, []);

  const reconcileSlotIds = useCallback(
    (nextPatches: BinarySource[]): string[] => {
      const previousIds = getBinarySourceListStableIds(currentPatchesRef.current);
      const nextIds = getBinarySourceListStableIds(nextPatches);
      const used = new Set<number>();
      return nextIds.map((sourceId, index) => {
        const exact = previousIds.findIndex(
          (candidate, candidateIndex) => candidate === sourceId && !used.has(candidateIndex),
        );
        const previousIndex = exact >= 0 ? exact : index < patchSlotIdsRef.current.length ? index : -1;
        if (previousIndex >= 0 && !used.has(previousIndex) && patchSlotIdsRef.current[previousIndex]) {
          used.add(previousIndex);
          return patchSlotIdsRef.current[previousIndex] as string;
        }
        return newSlotId();
      });
    },
    [newSlotId],
  );

  // Mirror the latest patch list and drop toggles whose source has gone away. Called from the form's
  // onPatchesChange handler before its own selection-sync/prop-forwarding, preserving call order.
  const syncPatchTracking = useCallback(
    (nextPatches: BinarySource[]) => {
      const nextSlotIds = reconcileSlotIds(nextPatches);
      currentPatchesRef.current = nextPatches;
      patchSlotIdsRef.current = nextSlotIds;
      // Drop stale toggles so a removed slot cannot disable a later replacement/addition.
      const ids = new Set(nextSlotIds);
      const retainKnownIds = (previous: ReadonlySet<string>): ReadonlySet<string> => {
        const next = new Set([...previous].filter((id) => ids.has(id)));
        return next.size === previous.size ? previous : next;
      };
      setDisabledPatchIds(retainKnownIds);
    },
    [reconcileSlotIds],
  );

  const togglePatchEnabled = useCallback((index: number) => {
    const id = patchSlotIdsRef.current[index];
    if (id === undefined) return;
    setDisabledPatchIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Seed a bundle session's default enablement in one pass. */
  const seedPatchEnablement = useCallback((entries: Array<{ id: string; enabled: boolean }>) => {
    setDisabledPatchIds((previous) => {
      const next = new Set(previous);
      for (const entry of entries) {
        if (entry.enabled) next.delete(entry.id);
        else next.add(entry.id);
      }
      return next;
    });
  }, []);

  const filterEnabledPatchRun = useCallback(<TOption>(patches: BinarySource[], options?: readonly TOption[]) => {
    const disabled = disabledPatchIdsRef.current;
    if (!disabled.size) return { patches, ...(options ? { patchOptions: options.slice() } : {}) };
    const ids = patchSlotIdsRef.current;
    const keep = patches.map((_, index) => {
      const id = ids[index];
      return id === undefined || !disabled.has(id);
    });
    return {
      patches: patches.filter((_, index) => keep[index]),
      ...(options ? { patchOptions: options.filter((_, index) => keep[index]) } : {}),
    };
  }, []);

  const getPatchIds = useCallback(() => patchSlotIdsRef.current.slice(), []);

  /** Index-aligned disabled set for `patches` (reads the live toggle state, so it is safe to call
   * from stable callbacks): feeds the deep dry-run validation so toggled-off patches are skipped. */
  const getDisabledPatchIndexes = useCallback((_patches: BinarySource[]): ReadonlySet<number> => {
    const disabled = disabledPatchIdsRef.current;
    const indexes = new Set<number>();
    if (!disabled.size) return indexes;
    const ids = patchSlotIdsRef.current;
    ids.forEach((id, index) => {
      if (id !== undefined && disabled.has(id)) indexes.add(index);
    });
    return indexes;
  }, []);

  return {
    disabledPatchIds,
    filterEnabledPatchRun,
    getDisabledPatchIndexes,
    getPatchIds,
    seedPatchEnablement,
    syncPatchTracking,
    togglePatchEnabled,
  };
};

export { useApplyPatchEnablement };
