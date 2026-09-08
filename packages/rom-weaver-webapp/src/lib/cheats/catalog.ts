import { type IdentifyCatalog, normalizePlatformAlias, resolveCatalogPlatform } from "../identify/identify-catalog.ts";
import {
  cheatDelivery,
  type ClassifiedCheatRecord,
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
  type CheatFilter,
  type CheatGameMatch,
  type CheatGameRecord,
  type CheatRomIdentity,
  type CheatSystemShard,
} from "./model.ts";

const GAME_BOY_SLUG = "nintendo-game-boy";
const GAME_BOY_COLOR_SLUG = "nintendo-game-boy-color";

/** Cartridge extensions that name a platform when ingest reported no tag. */
const SLUG_BY_EXTENSION: Record<string, string> = {
  gb: GAME_BOY_SLUG,
  gba: "nintendo-game-boy-advance",
  gbc: GAME_BOY_COLOR_SLUG,
};

const extensionOf = (fileName: string | undefined): string =>
  (fileName ?? "").slice((fileName ?? "").lastIndexOf(".") + 1).toLocaleLowerCase("en-US");

/**
 * Pick the shard for a ROM's platform tag. The identify catalog owns the alias
 * rules, so whatever name ingest reported resolves to the same pack slug the
 * identify run uses; a deployment without a catalog falls back to comparing
 * normalized platform names against the index rows.
 */
export const resolveCheatDatabaseEntry = (
  index: CheatDatabaseIndex | undefined,
  catalog: IdentifyCatalog | undefined,
  identity: Pick<CheatRomIdentity, "platform" | "fileName"> | null,
): CheatDatabaseEntry | undefined => {
  if (!(index && identity)) return undefined;
  const platform = identity.platform;
  let slug = platform ? resolveCatalogPlatform(catalog, platform)?.packSlug : undefined;
  if (!slug && platform) {
    const normalized = normalizePlatformAlias(platform);
    slug = index.entries.find((entry) => normalizePlatformAlias(entry.platform) === normalized)?.slug;
  }
  if (!(slug || platform)) slug = SLUG_BY_EXTENSION[extensionOf(identity.fileName)];
  // Game Boy and Game Boy Color share one header layout, so ingest tags both
  // as Game Boy; the file extension is the one signal that separates them.
  if (slug === GAME_BOY_SLUG && extensionOf(identity.fileName) === "gbc") {
    slug = index.entries.some((entry) => entry.slug === GAME_BOY_COLOR_SLUG) ? GAME_BOY_COLOR_SLUG : slug;
  }
  return index.entries.find((entry) => entry.slug === slug);
};

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

export const matchCheatGame = (
  identity: CheatRomIdentity | null,
  entry: CheatDatabaseEntry | undefined,
  shard?: CheatSystemShard,
): CheatGameMatch => {
  if (!identity) return { kind: "no-rom" };
  if (!entry) return { kind: "unsupported-system", platform: identity.platform };
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
