import {
  manualCheatId,
  type CheatRecord,
  type DatabaseCheatClassifier,
  type ManualCheatClassifier,
} from "../../lib/cheats/index.ts";
import type { SourceRef } from "../../types/source.ts";
import { loadBrowserApi } from "./workflow-loader.ts";

type CheatBrowserApi = Pick<Awaited<ReturnType<typeof loadBrowserApi>>, "runBrowserCheats">;

type CheatBrowserApiLoader = () => Promise<CheatBrowserApi>;

type CheatClassifiers = {
  classifyDatabaseCheats: DatabaseCheatClassifier;
  classifyManualCode: ManualCheatClassifier;
};

const createCheatClassifiers = (
  getCheatSource: () => SourceRef,
  loadApi: CheatBrowserApiLoader = loadBrowserApi,
): CheatClassifiers => {
  const classifyDatabaseCheats: DatabaseCheatClassifier = async (records) => {
    const { runBrowserCheats } = await loadApi();
    return (await runBrowserCheats({ records, rom: getCheatSource() })).records;
  };

  const classifyManualCode: ManualCheatClassifier = async ({ code, description, kind, system }) => {
    const record: CheatRecord = {
      ...(kind === "auto" ? {} : { codeKind: kind }),
      description,
      gameId: "manual",
      id: manualCheatId(system, code, kind),
      rawCode: code,
      rawFields: { code, desc: description, enable: "false" },
      sourceFile: "manual",
      sourceIndex: 0,
      sourceRevision: "manual",
      system,
    };
    const { runBrowserCheats } = await loadApi();
    const classified = (await runBrowserCheats({ records: [record], rom: getCheatSource() })).records[0];
    if (!classified) throw new Error("ROMWeaver did not return a cheat classification");
    return {
      detectedSystem: system,
      detectedType: classified.detectedKind || classified.resolution.type,
      record: classified,
    };
  };

  return { classifyDatabaseCheats, classifyManualCode };
};

export { createCheatClassifiers };
