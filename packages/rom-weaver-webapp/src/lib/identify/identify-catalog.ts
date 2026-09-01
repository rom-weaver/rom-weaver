/**
 * Parses `catalog.json` (format `rom-weaver-identify-catalog-v1`) and routes a
 * detected platform name through its aliases to the pack that owns it. The
 * catalog is the authority on which locally shipped pack serves each platform.
 */
type IdentifyCatalogSource = "libretro" | "opengood";

type IdentifyCatalogPlatform = {
  aliases: string[];
  canonicalPlatform: string;
  mediaProfiles: string[];
  packFormat: string;
  packSha256: string;
  packSlug: string;
  source: IdentifyCatalogSource;
};

type IdentifyCatalog = {
  format: string;
  generated?: {
    libretroRevision?: string;
    opengoodRevision?: string;
  };
  platforms: IdentifyCatalogPlatform[];
};

const IDENTIFY_CATALOG_FORMAT = "rom-weaver-identify-catalog-v1";

/** Mirrors the platform alias normalizer used by the identify data scripts. */
const normalizePlatformAlias = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();

const isCatalogSource = (value: unknown): value is IdentifyCatalogSource =>
  value === "libretro" || value === "opengood";

const parseCatalogPlatform = (value: unknown): IdentifyCatalogPlatform | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const canonicalPlatform = typeof record.canonicalPlatform === "string" ? record.canonicalPlatform : "";
  const packSlug = typeof record.packSlug === "string" ? record.packSlug : "";
  if (!(canonicalPlatform && packSlug && isCatalogSource(record.source))) return undefined;
  // The slug becomes a fetch path (`<origin>/<slug>.pack`) and a store key, so
  // it MUST NOT carry separators or dots. Mirrors the Rust catalog parser.
  if (!/^[a-z0-9-]+$/u.test(packSlug)) return undefined;
  // A catalog-only pack MUST carry its content hash before the app reads it.
  if (!/^[0-9a-f]{64}$/u.test(String(record.packSha256 ?? ""))) {
    return undefined;
  }
  return {
    aliases: Array.isArray(record.aliases) ? record.aliases.filter((alias) => typeof alias === "string") : [],
    canonicalPlatform,
    mediaProfiles: Array.isArray(record.mediaProfiles)
      ? record.mediaProfiles.filter((profile) => typeof profile === "string")
      : [],
    packFormat: typeof record.packFormat === "string" ? record.packFormat : "RWFP1",
    packSha256: typeof record.packSha256 === "string" ? record.packSha256 : "",
    packSlug,
    source: record.source,
  };
};

/**
 * Parse a catalog payload. Returns `undefined` for a payload that is not a
 * v1 catalog - callers treat that as "no catalog" and keep the index-only
 * behavior, because an old deployment simply has no catalog.json yet.
 */
const parseIdentifyCatalog = (value: unknown): IdentifyCatalog | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.format !== IDENTIFY_CATALOG_FORMAT || !Array.isArray(record.platforms)) return undefined;
  const platforms = record.platforms
    .map(parseCatalogPlatform)
    .filter((platform): platform is IdentifyCatalogPlatform => platform !== undefined);
  return {
    format: IDENTIFY_CATALOG_FORMAT,
    ...(typeof record.generated === "object" && record.generated !== null
      ? { generated: record.generated as IdentifyCatalog["generated"] }
      : {}),
    platforms,
  };
};

/**
 * Resolve a platform name (canonical, alias, or loosely formatted) to its
 * catalog entry. Matching is case-insensitive after alias normalization.
 */
const resolveCatalogPlatform = (
  catalog: IdentifyCatalog | undefined,
  platform: string,
): IdentifyCatalogPlatform | undefined => {
  if (!catalog) return undefined;
  const normalized = normalizePlatformAlias(platform);
  if (!normalized) return undefined;
  for (const entry of catalog.platforms) {
    if (normalizePlatformAlias(entry.canonicalPlatform) === normalized) return entry;
    if (entry.aliases.some((alias) => normalizePlatformAlias(alias) === normalized)) return entry;
  }
  return undefined;
};

const findCatalogPlatformBySlug = (
  catalog: IdentifyCatalog | undefined,
  slug: string,
): IdentifyCatalogPlatform | undefined => catalog?.platforms.find((entry) => entry.packSlug === slug);

export { findCatalogPlatformBySlug, normalizePlatformAlias, parseIdentifyCatalog, resolveCatalogPlatform };
export type { IdentifyCatalog };
