import {
  cheatDelivery,
  type ClassifiedCheatRecord,
  type CheatFilter,
  type CheatGameMatch,
  type CheatGameRecord,
  type CheatRomIdentity,
  type CheatSystemShard,
  isCheatDatabaseSystem,
} from "./model.ts";

const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/\.[a-z0-9]{1,8}$/u, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

const checksumValues = (game: CheatGameRecord): Array<[string, string]> =>
  game.checksums.flatMap((release) =>
    (["crc32", "md5", "sha1"] as const).flatMap((algorithm) => {
      const value = release[algorithm];
      return value ? [[algorithm, value] as const] : [];
    }),
  );

export const matchCheatGame = (identity: CheatRomIdentity | null, shard?: CheatSystemShard): CheatGameMatch => {
  if (!identity) return { kind: "no-rom" };
  if (!isCheatDatabaseSystem(identity.system)) return { kind: "unsupported-system", system: identity.system };
  if (!shard) return { kind: "none" };

  const checksums = new Map(
    Object.entries(identity.checksums ?? {}).map(([algorithm, value]) => [
      algorithm.toLocaleLowerCase("en-US"),
      (Array.isArray(value) ? value : [value]).map((item) => item.toLocaleLowerCase("en-US")),
    ]),
  );
  const exact = shard.games.find((game) =>
    checksumValues(game).some(([algorithm, value]) =>
      checksums.get(algorithm)?.includes(value.toLocaleLowerCase("en-US")),
    ),
  );
  if (exact) return { kind: "exact", game: exact };

  const title = normalizeText(identity.title || identity.fileName || "");
  if (!title) return { kind: "none" };
  const probable = shard.games.find((game) =>
    [game.title, game.normalizedTitle].some((candidate) => normalizeText(candidate) === title),
  );
  return probable ? { kind: "title", game: probable } : { kind: "none" };
};

export const selectManualGame = (shard: CheatSystemShard | undefined, gameId: string): CheatGameMatch => {
  const game = shard?.games.find((candidate) => candidate.id === gameId);
  return game ? { kind: "manual", game } : { kind: "none" };
};

export const filterCheats = (
  cheats: ClassifiedCheatRecord[],
  query: string,
  filter: CheatFilter,
): ClassifiedCheatRecord[] => {
  const needle = normalizeText(query);
  return cheats.filter((cheat) => {
    if (needle && !normalizeText(`${cheat.record.description} ${cheat.record.rawCode ?? ""}`).includes(needle)) {
      return false;
    }
    if (filter === "all") return true;
    return cheatDelivery(cheat) === filter;
  });
};

export const reconcileSelectedCheatIds = (
  selectedIds: ReadonlySet<string>,
  records: ClassifiedCheatRecord[],
): Set<string> => {
  const available = new Set(records.map(({ record }) => record.id));
  return new Set([...selectedIds].filter((id) => available.has(id)));
};
