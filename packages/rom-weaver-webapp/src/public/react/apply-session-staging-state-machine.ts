import { type MutableRefObject, useCallback, useMemo, useRef } from "react";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";

type StageGenerationMachine = {
  currentProgressGeneration: () => number;
  currentStageGeneration: () => number;
  invalidateStage: () => number;
  isCurrentProgressGeneration: (generation: number, progressGeneration: number) => boolean;
  isCurrentStageGeneration: (generation: number) => boolean;
  nextProgressGeneration: () => number;
  nextRunGeneration: () => { generation: number; progressGeneration: number };
  nextStageGeneration: () => number;
  progressGenerationRef: MutableRefObject<number>;
  stageGenerationRef: MutableRefObject<number>;
};

const hasSameRecordValues = <T>(left: Record<string, T>, right: Record<string, T>) => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
};

const useStageGenerationMachine = (): StageGenerationMachine => {
  const stageGenerationRef = useRef(0);
  const progressGenerationRef = useRef(0);
  return useMemo(() => {
    const nextStageGeneration = () => {
      stageGenerationRef.current += 1;
      return stageGenerationRef.current;
    };
    const nextProgressGeneration = () => {
      progressGenerationRef.current += 1;
      return progressGenerationRef.current;
    };
    return {
      currentProgressGeneration: () => progressGenerationRef.current,
      currentStageGeneration: () => stageGenerationRef.current,
      invalidateStage: nextStageGeneration,
      isCurrentProgressGeneration: (generation: number, progressGeneration: number) =>
        stageGenerationRef.current === generation && progressGenerationRef.current === progressGeneration,
      isCurrentStageGeneration: (generation: number) => stageGenerationRef.current === generation,
      nextProgressGeneration,
      nextRunGeneration: () => ({
        generation: nextStageGeneration(),
        progressGeneration: nextProgressGeneration(),
      }),
      nextStageGeneration,
      progressGenerationRef,
      stageGenerationRef,
    };
  }, []);
};

const useStableSourceKeys = (sources: BinarySource[], prefix: "input" | "patch") => {
  const objectKeyMapRef = useRef(new WeakMap<object, string>());
  const stableKeyMapRef = useRef(new Map<string, string>());
  const nextKeyRef = useRef(0);
  const getKeys = useCallback(
    (sourceList: BinarySource[]) =>
      getBinarySourceListStableIds(sourceList).map((stableId, index) => {
        const sourceObject = sourceList[index] as object | undefined;
        let key =
          (sourceObject ? objectKeyMapRef.current.get(sourceObject) : undefined) ||
          stableKeyMapRef.current.get(stableId);
        if (!key) {
          nextKeyRef.current += 1;
          key = `${prefix}-${nextKeyRef.current}`;
          stableKeyMapRef.current.set(stableId, key);
        }
        if (sourceObject) objectKeyMapRef.current.set(sourceObject, key);
        return key;
      }),
    [prefix],
  );
  const keys = useMemo(() => {
    // Forget keys for sources no longer in the list: once a source is cleared/removed, its
    // signature→key and object→key bindings must not survive, or re-adding the same file (same object
    // OR same name/size/lastModified signature) would silently reuse the old key - reusing the prior
    // extraction/selection instead of re-staging and re-prompting. Rebuild both maps from the current
    // list so a fresh re-add mints a new key. Pure appends keep every existing binding, so the
    // append fast-path (no full re-stage) is preserved.
    const liveStableIds = new Set(getBinarySourceListStableIds(sources));
    for (const stableId of stableKeyMapRef.current.keys()) {
      if (!liveStableIds.has(stableId)) stableKeyMapRef.current.delete(stableId);
    }
    const result = getKeys(sources);
    const nextObjectKeyMap = new WeakMap<object, string>();
    sources.forEach((source, index) => {
      const key = result[index];
      if (source && typeof source === "object" && key) nextObjectKeyMap.set(source as object, key);
    });
    objectKeyMapRef.current = nextObjectKeyMap;
    return result;
  }, [getKeys, sources]);
  const getKey = useCallback(
    (source: BinarySource, sourceList: BinarySource[] = sources) => {
      const index = sourceList.indexOf(source);
      if (sourceList === sources) return index >= 0 ? keys[index] || "" : "";
      return index >= 0 ? getKeys(sourceList)[index] || "" : "";
    },
    [getKeys, keys, sources],
  );
  return { getKey, keys };
};

export type { StageGenerationMachine };
export { hasSameRecordValues, useStableSourceKeys, useStageGenerationMachine };
