import { type IdentifyCatalog, normalizePlatformAlias, resolveCatalogPlatform } from "../identify/identify-catalog.ts";
import {
  type ClassifiedCheatRecord,
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
  type CheatGameMatch,
  type CheatGameRecord,
  type CheatRomIdentity,
  type CheatSystemShard,
} from "./model.ts";

const GAME_BOY_SLUG = "nintendo-game-boy";
const GAME_BOY_COLOR_SLUG = "nintendo-game-boy-color";
const MASTER_SYSTEM_SLUG = "sega-master-system-mark-iii";
const GAME_GEAR_SLUG = "sega-game-gear";
const MEGA_DRIVE_SLUG = "sega-mega-drive-genesis";
const SEGA_32X_SLUG = "sega-32x";

/** Cartridge extensions that name a platform when ingest reported no tag. */
const SLUG_BY_EXTENSION: Record<string, string> = {
  gb: GAME_BOY_SLUG,
  gba: "nintendo-game-boy-advance",
  gbc: GAME_BOY_COLOR_SLUG,
  sms: MASTER_SYSTEM_SLUG,
  gg: GAME_GEAR_SLUG,
  "32x": SEGA_32X_SLUG,
};

/**
 * Consoles that share a ROM header with another console, so ingest reports one
 * platform tag for both. The file extension is the one signal that separates
 * them, and the narrower shard is used only when the index carries it.
 */
const EXTENSION_OVERRIDES: Array<{ from: string; extension: string; to: string }> = [
  { from: GAME_BOY_SLUG, extension: "gbc", to: GAME_BOY_COLOR_SLUG },
  { from: MASTER_SYSTEM_SLUG, extension: "gg", to: GAME_GEAR_SLUG },
  { from: MEGA_DRIVE_SLUG, extension: "32x", to: SEGA_32X_SLUG },
];

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
  const extension = extensionOf(identity.fileName);
  const override = EXTENSION_OVERRIDES.find((rule) => rule.from === slug && rule.extension === extension);
  if (override && index.entries.some((entry) => entry.slug === override.to)) slug = override.to;
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

export const filterCheats = (cheats: ClassifiedCheatRecord[], query: string): ClassifiedCheatRecord[] => {
  const needle = normalizeText(query);
  if (!needle) return cheats;
  return cheats.filter((cheat) =>
    normalizeText(`${cheat.record.description} ${cheat.record.rawCode ?? ""}`).includes(needle),
  );
};

export const reconcileSelectedCheatIds = (
  selectedIds: ReadonlySet<string>,
  records: ClassifiedCheatRecord[],
): Set<string> => {
  const available = new Set(records.map(({ record }) => record.id));
  return new Set([...selectedIds].filter((id) => available.has(id)));
};
