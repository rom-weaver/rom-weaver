import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { cheatDelivery, type CheatManualSystem, type ClassifiedCheatRecord } from "../../lib/cheats/index.ts";
import type { ApplyWorkflow, BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import { getCheatPatchCodes, getCheatPatchFileName, getCheatPatchFormat } from "./cheat-patch-export-model.ts";
import { createCheatClassifiers } from "./cheat-classifier.ts";
import type { useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import { type createWorkflowHandle, loadBrowserApi } from "./workflow-loader.ts";

type ApplyCheatsInput = {
  preparedWorkflowRef: RefObject<ApplyWorkflow | null>;
  resolvedAssetBaseUrl: string | undefined;
  resolvedUiController: ReturnType<typeof useLocalApplyPatchFormSession>["localUiController"];
  selectedCheatPositionsRef: RefObject<number[]>;
  selectedCheatsRef: RefObject<ClassifiedCheatRecord[]>;
  setCheatConflictMessage: Dispatch<SetStateAction<string>>;
  setCheatNames: Dispatch<SetStateAction<string[]>>;
  setCheatsOn: Dispatch<SetStateAction<boolean>>;
  setCompletedCheats: Dispatch<SetStateAction<BrowserApplyResult["cheats"]>>;
  setCompletedOutput: Dispatch<SetStateAction<BrowserApplyResult["output"] | null>>;
  workflowHandle: ReturnType<typeof createWorkflowHandle<ApplyWorkflow>>;
};

/** Cheat card state for the apply form: the single staged ROM's identity, classifiers, and selection handling. */
const useApplyCheats = ({
  preparedWorkflowRef,
  resolvedAssetBaseUrl,
  resolvedUiController,
  selectedCheatPositionsRef,
  selectedCheatsRef,
  setCheatConflictMessage,
  setCheatNames,
  setCheatsOn,
  setCompletedCheats,
  setCompletedOutput,
  workflowHandle,
}: ApplyCheatsInput) => {
  const cheatUiState = useSyncExternalStore(
    resolvedUiController.subscribe,
    resolvedUiController.getState,
    resolvedUiController.getState,
  );
  const cheatRomRow = cheatUiState.romInputs.length === 1 ? cheatUiState.romInputs[0] : undefined;
  const cheatFileName = cheatRomRow?.info.fileName || cheatRomRow?.info.archiveName || "";
  const cheatPlatform = cheatRomRow?.info.romType?.platform;
  const cheatChecksums = useMemo(() => {
    if (!cheatRomRow) return undefined;
    const values: Record<string, string[]> = {};
    const add = (algorithm: string, value: string | undefined) => {
      if (!value) return;
      values[algorithm] ??= [];
      const list = values[algorithm];
      if (!list.includes(value)) list.push(value);
    };
    add("crc32", cheatRomRow.info.crc32);
    add("md5", cheatRomRow.info.md5);
    add("sha1", cheatRomRow.info.sha1);
    for (const variant of cheatRomRow.info.checksumVariants || []) {
      for (const [algorithm, value] of Object.entries(variant.checksums)) add(algorithm, value);
    }
    return values;
  }, [cheatRomRow]);
  const cheatRom = useMemo(
    () =>
      cheatRomRow
        ? {
            checksums: cheatChecksums,
            fileName: cheatFileName,
            key: `${cheatRomRow.id}:${cheatRomRow.info.sha1 || cheatRomRow.info.crc32 || cheatFileName}`,
            platform: cheatPlatform,
            title: cheatFileName,
          }
        : null,
    [cheatChecksums, cheatFileName, cheatPlatform, cheatRomRow],
  );
  const getCheatSource = useCallback(() => {
    const source = (preparedWorkflowRef.current || workflowHandle.peek())?.getBundleExportSources().rom?.source;
    if (!source) throw new Error("Wait for ROM staging to finish before checking cheats");
    return source;
  }, [preparedWorkflowRef, workflowHandle]);
  const { classifyDatabaseCheats, classifyManualCode } = useMemo(
    () => createCheatClassifiers(getCheatSource),
    [getCheatSource],
  );
  const saveCheatsAsPatch = useCallback(
    async (records: ClassifiedCheatRecord[], system: CheatManualSystem | undefined) => {
      const codes = getCheatPatchCodes(records);
      if (!codes.length) throw new Error("Turn on at least one ROM cheat to bake it into a patch");
      const format = getCheatPatchFormat(cheatRomRow?.size);
      const fileName = getCheatPatchFileName(cheatFileName, records, format);
      const { CreateWorkflow } = await loadBrowserApi();
      // The patch is a side product of this apply run, so it gets its own
      // short-lived workflow: the apply workflow owns the run's own output.
      const workflow = new CreateWorkflow({
        ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
        settings: { format, output: { compression: "none", outputName: fileName } },
      });
      try {
        await workflow.setOriginal(getCheatSource() as never);
        await workflow.setCheatCodes(codes, system);
        await workflow.setPatchType(format);
        await workflow.setOutputName(fileName);
        const result = await workflow.run();
        await result.output.saveAs({ interactive: true });
        return result.output.fileName;
      } finally {
        await workflow.dispose().catch(() => undefined);
      }
    },
    [cheatFileName, cheatRomRow?.size, getCheatSource, resolvedAssetBaseUrl],
  );
  const preflightSequence = useRef(0);
  const handleCheatSelection = useCallback(
    (records: ClassifiedCheatRecord[], positions: number[] = []) => {
      selectedCheatsRef.current = records;
      selectedCheatPositionsRef.current = positions;
      // ROM cheat offsets refer to the staged bytes, so selected ROM writes
      // prevent header stripping during apply.
      const romRecords = records.filter((record) => cheatDelivery(record) === "rom").map(({ record }) => record);
      const romPositions = records.flatMap((record, index) =>
        cheatDelivery(record) === "rom" ? [positions[index] ?? 0] : [],
      );
      setCheatsOn(romRecords.length > 0);
      setCheatNames(romRecords.map((record) => record.description));
      setCompletedOutput(null);
      setCompletedCheats(undefined);
      (preparedWorkflowRef.current || workflowHandle.peek())?.setCheats?.(romRecords, romPositions);
      const sequence = ++preflightSequence.current;
      setCheatConflictMessage("");
      if (romRecords.length < 2) return;
      const groups = new Map<number, typeof romRecords>();
      romRecords.forEach((record, index) => {
        const position = romPositions[index] ?? 0;
        groups.set(position, [...(groups.get(position) || []), record]);
      });
      const groupsToCheck = [...groups.values()].filter((group) => group.length > 1);
      if (!groupsToCheck.length) return;
      const descriptions = new Map(romRecords.map((record) => [record.id, record.description]));
      void loadBrowserApi()
        .then(async ({ runBrowserCheats }) => {
          for (const group of groupsToCheck) {
            const { conflicts } = await runBrowserCheats({ records: group, rom: getCheatSource() });
            if (conflicts[0]) return conflicts[0];
          }
          return undefined;
        })
        .then((conflict) => {
          if (sequence !== preflightSequence.current || !conflict) return;
          const firstDescription = descriptions.get(conflict.firstId) || conflict.firstId;
          const secondDescription = descriptions.get(conflict.secondId) || conflict.secondId;
          setCheatConflictMessage(
            `Cheat conflict at ROM offset 0x${conflict.offset.toString(16).toUpperCase()}: ` +
              `${firstDescription} writes ${conflict.firstValue.toString(16).padStart(2, "0").toUpperCase()}, ` +
              `${secondDescription} writes ${conflict.secondValue.toString(16).padStart(2, "0").toUpperCase()}.`,
          );
        })
        .catch((error: unknown) => {
          if (sequence === preflightSequence.current) {
            setCheatConflictMessage(error instanceof Error ? error.message : "Cheat conflict validation failed");
          }
        });
    },
    [
      getCheatSource,
      preparedWorkflowRef,
      selectedCheatPositionsRef,
      selectedCheatsRef,
      setCheatConflictMessage,
      setCheatNames,
      setCheatsOn,
      setCompletedCheats,
      setCompletedOutput,
      workflowHandle,
    ],
  );

  useEffect(() => {
    if (cheatUiState.romInputs.length === 1) return;
    // Cheats MUST be cleared without one ROM so Apply cannot reuse their ROM writes.
    handleCheatSelection([]);
  }, [cheatUiState.romInputs.length, handleCheatSelection]);

  return { cheatRom, classifyDatabaseCheats, classifyManualCode, handleCheatSelection, saveCheatsAsPatch };
};

export { useApplyCheats };
