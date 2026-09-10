import { useEffect, useMemo, useState } from "react";
import {
  createCheatDatabaseClient,
  matchCheatGame,
  parseCheatDatabaseIndex,
  resolveCheatDatabaseEntry,
  resolveManualOnlyCheatSystem,
  selectManualGame,
  type CheatDatabaseClient,
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
  type CheatDatabaseSystem,
  type CheatGameMatch,
  type CheatGameRecord,
  type CheatManualOnlySystem,
  type CheatManualSystem,
  type CheatRomIdentity,
  type CheatSystemShard,
  type ClassifiedCheatRecord,
  type DatabaseCheatClassifier,
} from "../../../lib/cheats/index.ts";
import type { IdentifyCatalog } from "../../../lib/identify/identify-catalog.ts";
import { loadIdentifyIndexAndCatalog } from "../../../platform/browser/identify-packs.ts";

type CheatDatabaseRecordsInput = {
  rom: CheatRomIdentity | null;
  index?: CheatDatabaseIndex;
  catalog?: IdentifyCatalog;
  shard?: CheatSystemShard;
  client?: CheatDatabaseClient;
  classifyDatabaseCheats: DatabaseCheatClassifier;
};

type CheatDatabaseRecordsState = {
  activeCatalog?: IdentifyCatalog;
  activeIndex?: CheatDatabaseIndex;
  classificationError: string;
  classifying: boolean;
  entry?: CheatDatabaseEntry;
  game?: CheatGameRecord;
  loadError: string;
  loading: boolean;
  manualGameId: string;
  /** Set only when no shard covers the ROM's system but the decoder does. */
  manualOnlySystem?: CheatManualOnlySystem;
  /** Every system a hand-entered code may be classified against for this ROM. */
  manualSystem?: CheatManualSystem;
  match: CheatGameMatch;
  records: ClassifiedCheatRecord[];
  setManualGameId: (id: string) => void;
  shard?: CheatSystemShard;
  system?: CheatDatabaseSystem;
};

const loadCheatDatabase = async (): Promise<{ index: CheatDatabaseIndex; catalog: IdentifyCatalog | undefined }> => {
  const { index, catalog } = await loadIdentifyIndexAndCatalog();
  const parsed = parseCheatDatabaseIndex(index);
  if (!parsed) throw new Error("This deployment ships no cheat database.");
  return { index: parsed, catalog };
};

const matchGame = (match: CheatGameMatch) => ("game" in match ? match.game : undefined);

/**
 * Loads the cheat database for one ROM, matches its game, and classifies that
 * game's cheats through the Rust decoder. Shared by the apply workflow's Cheats
 * step and the create workflow's cheat-codes mode so both see the same rows.
 */
const useCheatDatabaseRecords = ({
  rom,
  index,
  catalog,
  shard: suppliedShard,
  client: suppliedClient,
  classifyDatabaseCheats,
}: CheatDatabaseRecordsInput): CheatDatabaseRecordsState => {
  const [loadedShard, setLoadedShard] = useState<CheatSystemShard>();
  const [loadedIndex, setLoadedIndex] = useState<CheatDatabaseIndex>();
  const [loadedCatalog, setLoadedCatalog] = useState<IdentifyCatalog>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [manualGameId, setManualGameId] = useState("");
  const [records, setRecords] = useState<ClassifiedCheatRecord[]>([]);
  const [classificationError, setClassificationError] = useState("");
  const [classifying, setClassifying] = useState(false);

  const activeIndex = index ?? loadedIndex;
  const activeCatalog = catalog ?? loadedCatalog;
  const entry = useMemo(
    () => resolveCheatDatabaseEntry(activeIndex, activeCatalog, rom),
    [activeCatalog, activeIndex, rom],
  );
  const system = entry?.cheatSystem;
  // The decoder covers systems no shard does (PlayStation). Those keep manual
  // entry, without a game list to browse.
  const manualOnlySystem = system ? undefined : resolveManualOnlyCheatSystem(activeCatalog, rom);
  const manualSystem: CheatManualSystem | undefined = system ?? manualOnlySystem;

  useEffect(() => {
    if (index) return;
    let active = true;
    setLoadError("");
    void loadCheatDatabase()
      .then((loaded) => {
        if (!active) return;
        setLoadedIndex(loaded.index);
        setLoadedCatalog(loaded.catalog);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : "The cheat database is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [index]);

  useEffect(() => {
    if (suppliedShard || !entry) {
      setLoadedShard(undefined);
      return;
    }
    const client = suppliedClient ?? createCheatDatabaseClient();
    let active = true;
    setLoading(true);
    setLoadError("");
    void client
      .loadShard(entry)
      .then((nextShard) => {
        if (active) setLoadedShard(nextShard);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(reason instanceof Error ? reason.message : "The cheat database is unavailable.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (!suppliedClient) client.close();
    };
  }, [entry, suppliedClient, suppliedShard]);

  const shard = suppliedShard ?? loadedShard;
  const automaticMatch = useMemo(() => matchCheatGame(rom, entry, shard), [entry, rom, shard]);
  const match = manualGameId ? selectManualGame(shard, manualGameId) : automaticMatch;
  const game = matchGame(match);

  useEffect(() => {
    if (!(game && system)) {
      setRecords([]);
      return;
    }
    let active = true;
    setClassifying(true);
    setClassificationError("");
    void classifyDatabaseCheats(game.cheats, system)
      .then((nextRecords) => {
        if (active) setRecords(nextRecords);
      })
      .catch((reason: unknown) => {
        if (active) {
          setRecords([]);
          setClassificationError(
            reason instanceof Error ? reason.message : "The cheat records could not be classified.",
          );
        }
      })
      .finally(() => {
        if (active) setClassifying(false);
      });
    return () => {
      active = false;
    };
  }, [classifyDatabaseCheats, game, system]);

  return {
    ...(activeCatalog ? { activeCatalog } : {}),
    ...(activeIndex ? { activeIndex } : {}),
    classificationError,
    classifying,
    ...(entry ? { entry } : {}),
    ...(game ? { game } : {}),
    loadError,
    loading,
    manualGameId,
    ...(manualOnlySystem ? { manualOnlySystem } : {}),
    ...(manualSystem ? { manualSystem } : {}),
    match,
    records,
    setManualGameId,
    ...(shard ? { shard } : {}),
    ...(system ? { system } : {}),
  };
};

export { matchGame, useCheatDatabaseRecords };
