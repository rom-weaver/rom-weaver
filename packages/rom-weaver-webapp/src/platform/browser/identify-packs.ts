/**
 * Fetches the per-system identify packs the browser stages for the wasm ingest
 * command. Three properties matter here:
 *
 * 1. A pack that cannot be fetched, sized, or hashed is an UNAVAILABLE database,
 *    never a silent "no match". Callers get {@link IdentifyDataUnavailableError}
 *    so the UI can say so and offer a retry.
 * 2. Only the packs a ROM could plausibly match are downloaded. The whole set is
 *    6.7 MB raw, so loading it for every generic `.bin` would dwarf the work.
 * 3. Hasheous-derived packs are never fetched without stored user consent, and
 *    never as part of a "load everything" fallback - only when platform routing
 *    names their platform. A routed-but-unavailable Hasheous pack reports the
 *    `database_required` condition instead of a false "no match".
 */
import {
  findCatalogPlatformBySlug,
  parseIdentifyCatalog,
  resolveCatalogPlatform,
} from "../../lib/identify/identify-catalog.ts";
import type { IdentifyCatalog } from "../../lib/identify/identify-catalog.ts";
import { readIdentifyDatabaseSettings } from "../../lib/identify/identify-database-settings.ts";
import { getDefaultIdentifyPackStore } from "../../lib/identify/identify-pack-store.ts";
import { sha256Hex } from "../../lib/identify/sha256-hex.ts";

type IdentifySystem = {
  file: string;
  packFormat?: string;
  platform: string;
  rawBytes: number;
  sha256: string;
  slug: string;
  source: string;
};

type IdentifyIndex = {
  catalog?: string;
  format: string;
  systems: IdentifySystem[];
};

type BrowserIdentifyPack = {
  blob: Blob;
  fileName: string;
  platform: string;
  slug: string;
};

/** Hints the caller can offer before the ROM is hashed. Any of them may be absent. */
type IdentifyPackHints = {
  /** Names of the archive members, when the input is a container. */
  entryNames?: readonly string[];
  fileName?: string;
  /** Canonical platform name from the Rust ROM probe (see `platform_detection::platform`). */
  platform?: string;
};

/** A routed platform whose (Hasheous) database is not available locally. */
type IdentifyDatabaseRequirement = {
  hint: string;
  platform: string;
};

type IdentifyPackSelection = {
  databaseRequired?: IdentifyDatabaseRequirement;
  packs: BrowserIdentifyPack[];
};

/** Raised when the identification database itself could not be loaded or validated. */
class IdentifyDataUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdentifyDataUnavailableError";
  }
}

const DATA_ROOT = "assets/identify-";

const PLATFORM_BY_EXTENSION: Record<string, string[]> = {
  "32x": ["sega-32x"],
  a26: ["atari-2600"],
  a52: ["atari-5200"],
  a78: ["atari-7800"],
  fig: ["nintendo-super-nintendo-entertainment-system"],
  gb: ["nintendo-game-boy"],
  gba: ["nintendo-game-boy-advance"],
  gbc: ["nintendo-game-boy-color"],
  gen: ["sega-mega-drive-genesis"],
  gg: ["sega-game-gear"],
  lnx: ["atari-lynx"],
  md: ["sega-mega-drive-genesis"],
  n64: ["nintendo-64"],
  nes: ["nintendo-entertainment-system"],
  ngc: ["neo-geo-pocket-color"],
  ngp: ["neo-geo-pocket"],
  pce: ["turbografx-16-pc-engine"],
  sfc: ["nintendo-super-nintendo-entertainment-system"],
  sgx: ["turbografx-16-pc-engine"],
  smc: ["nintendo-super-nintendo-entertainment-system"],
  smd: ["sega-mega-drive-genesis"],
  sms: ["sega-master-system"],
  swc: ["nintendo-super-nintendo-entertainment-system"],
  unf: ["nintendo-entertainment-system"],
  unif: ["nintendo-entertainment-system"],
  v64: ["nintendo-64"],
  z64: ["nintendo-64"],
};

/**
 * Header detection cannot separate these siblings - a Game Boy Color cartridge
 * carries a Game Boy header, a Game Gear ROM carries an SMS header (see
 * `platform_detection::platform_for_rom_header`). Widening a detected slug to
 * its whole family keeps a correct match reachable; a wrong sibling simply
 * yields no CRC32 hit.
 */
const SIBLING_SLUGS: Record<string, string[]> = {
  "neo-geo-pocket": ["neo-geo-pocket-color"],
  "neo-geo-pocket-color": ["neo-geo-pocket"],
  "nintendo-game-boy": ["nintendo-game-boy-color"],
  "nintendo-game-boy-color": ["nintendo-game-boy"],
  "sega-32x": ["sega-mega-drive-genesis"],
  "sega-game-gear": ["sega-master-system"],
  "sega-master-system": ["sega-game-gear"],
  "sega-mega-drive-genesis": ["sega-32x"],
};

/** Mirrors `slugifyPlatform` in scripts/build-hasheous-identify-index.mjs. */
const slugifyPlatform = (platform: string): string =>
  platform
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const fileExtension = (name: string): string => {
  const base = name.split(/[\\/]/u).at(-1) || "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

const withSiblings = (slugs: Iterable<string>): string[] => {
  const out = new Set<string>();
  for (const slug of slugs) {
    out.add(slug);
    for (const sibling of SIBLING_SLUGS[slug] || []) out.add(sibling);
  }
  return [...out];
};

/**
 * Candidate pack slugs for an input, from the cheapest evidence available. An
 * empty result means "cannot be narrowed" and the caller MUST fall back to the
 * full set rather than skip a pack a ROM could have matched. When a catalog is
 * supplied, a detected platform name also routes through its catalog aliases,
 * which is what reaches the dynamically discovered Hasheous platforms.
 */
const selectIdentifySlugs = (
  { entryNames, fileName, platform }: IdentifyPackHints,
  catalog?: IdentifyCatalog,
): string[] => {
  const slugs = new Set<string>();
  if (platform?.trim()) {
    const catalogEntry = resolveCatalogPlatform(catalog, platform);
    slugs.add(catalogEntry ? catalogEntry.packSlug : slugifyPlatform(platform));
  }
  for (const name of [fileName || "", ...(entryNames || [])]) {
    for (const slug of PLATFORM_BY_EXTENSION[fileExtension(name)] || []) slugs.add(slug);
  }
  return withSiblings(slugs);
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const assetUrl = (name: string) => new URL(`${DATA_ROOT}${name}`, document.baseURI);
let indexPromise: Promise<IdentifyIndex> | undefined;
let catalogPromise: Promise<IdentifyCatalog | undefined> | undefined;
const packPromises = new Map<string, Promise<BrowserIdentifyPack>>();

/** Drop every cached index/catalog/pack promise so a retry refetches from the network. */
const resetIdentifyPackCache = () => {
  indexPromise = undefined;
  catalogPromise = undefined;
  packPromises.clear();
};

const loadIndex = async (): Promise<IdentifyIndex> => {
  let response: Response;
  try {
    response = await fetch(assetUrl("index.json"), { cache: "no-cache" });
  } catch (cause) {
    throw new IdentifyDataUnavailableError(`ROM identify index request failed: ${describe(cause)}`, { cause });
  }
  if (!response.ok) {
    throw new IdentifyDataUnavailableError(`ROM identify index request failed with HTTP ${response.status}`);
  }
  let index: Partial<IdentifyIndex>;
  try {
    index = (await response.json()) as Partial<IdentifyIndex>;
  } catch (cause) {
    throw new IdentifyDataUnavailableError(`ROM identify index is not valid JSON: ${describe(cause)}`, { cause });
  }
  if (index.format !== "rom-weaver-identify-system-pack-v1" || !Array.isArray(index.systems)) {
    throw new IdentifyDataUnavailableError("ROM identify index is invalid");
  }
  return index as IdentifyIndex;
};

/**
 * Load catalog.json when the deployment ships one. A missing or invalid
 * catalog degrades to index-only routing (OpenGood packs keep working), so
 * every failure resolves to `undefined` instead of throwing.
 */
const loadCatalog = async (): Promise<IdentifyCatalog | undefined> => {
  try {
    const response = await fetch(assetUrl("catalog.json"), { cache: "no-cache" });
    if (!response.ok) return undefined;
    return parseIdentifyCatalog(await response.json());
  } catch {
    return undefined;
  }
};

const getIndex = (): Promise<IdentifyIndex> => {
  if (!indexPromise) {
    indexPromise = loadIndex().catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  return indexPromise;
};

const getCatalog = (): Promise<IdentifyCatalog | undefined> => {
  if (!catalogPromise) catalogPromise = loadCatalog();
  return catalogPromise;
};

/** Verified pack bytes -> the staged blob shape the wasm runtime consumes. */
const toBrowserPack = (system: IdentifySystem, bytes: ArrayBuffer): BrowserIdentifyPack => ({
  blob: new Blob([bytes], { type: "application/octet-stream" }),
  fileName: system.file,
  platform: system.platform,
  slug: system.slug,
});

const verifyPackBytes = async (system: IdentifySystem, bytes: ArrayBuffer): Promise<void> => {
  // Size and SHA-256 both gate the pack: a truncated or substituted database
  // MUST NOT reach the parser. Size is skipped when the index never listed it
  // (catalog-only Hasheous packs).
  if (system.rawBytes > 0 && bytes.byteLength !== system.rawBytes) {
    throw new IdentifyDataUnavailableError(`ROM identify database size is invalid: ${system.file}`);
  }
  if (system.sha256 && (await sha256Hex(bytes)) !== system.sha256) {
    throw new IdentifyDataUnavailableError(`ROM identify database checksum is invalid: ${system.file}`);
  }
};

/**
 * Resolve where a pack downloads from. Hasheous packs honor the configurable
 * `identifyDatabaseOrigin` setting; everything else (and an unset origin) is
 * the same-origin self-hosted asset path. A cross-origin value MUST serve CORS
 * headers or the fetch fails as a network error.
 */
const packUrl = (system: IdentifySystem): URL => {
  const origin = readIdentifyDatabaseSettings().identifyDatabaseOrigin;
  const url =
    system.source === "hasheous" && origin
      ? new URL(`${origin.replace(/\/+$/u, "")}/${system.file}`)
      : assetUrl(system.file);
  if (system.sha256) url.searchParams.set("sha256", system.sha256);
  return url;
};

const fetchPackBytes = async (system: IdentifySystem): Promise<ArrayBuffer> => {
  let response: Response;
  try {
    response = await fetch(packUrl(system));
  } catch (cause) {
    throw new IdentifyDataUnavailableError(`ROM identify database request failed: ${system.file}: ${describe(cause)}`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new IdentifyDataUnavailableError(`ROM identify database request failed with HTTP ${response.status}`);
  }
  return response.arrayBuffer();
};

const loadPack = (system: IdentifySystem): Promise<BrowserIdentifyPack> => {
  const existing = packPromises.get(system.file);
  if (existing) return existing;
  const pending = (async () => {
    if (system.source === "hasheous") {
      // Cached-first: a verified copy in the manager's store is used offline
      // and without consent. Verification runs again on the stored bytes, so a
      // corrupted store entry cannot reach the parser either.
      const stored = await getDefaultIdentifyPackStore()
        .get(system.file)
        .catch(() => undefined);
      if (stored) {
        try {
          await verifyPackBytes(system, stored.bytes);
          return toBrowserPack(system, stored.bytes);
        } catch {
          // A stale or corrupt stored pack falls through to a fresh download;
          // the store entry is replaced only after the download verifies.
        }
      }
      if (!readIdentifyDatabaseSettings().hasheousConsent) {
        throw new IdentifyDataUnavailableError(
          `ROM identify database is not downloaded and downloads are not permitted: ${system.file}`,
        );
      }
      const bytes = await fetchPackBytes(system);
      await verifyPackBytes(system, bytes);
      await getDefaultIdentifyPackStore()
        .put(system.file, system.sha256, bytes)
        .catch(() => undefined);
      return toBrowserPack(system, bytes);
    }
    const bytes = await fetchPackBytes(system);
    await verifyPackBytes(system, bytes);
    return toBrowserPack(system, bytes);
  })().catch((error) => {
    packPromises.delete(system.file);
    throw error;
  });
  packPromises.set(system.file, pending);
  return pending;
};

/** Catalog platforms that never made it into the shipped index still get a loadable system record. */
const systemForSlug = (index: IdentifyIndex, catalog: IdentifyCatalog | undefined, slug: string) => {
  const indexed = index.systems.find((system) => system.slug === slug);
  if (indexed) return indexed;
  const entry = findCatalogPlatformBySlug(catalog, slug);
  if (!entry) return undefined;
  return {
    file: `${entry.packSlug}.pack`,
    packFormat: entry.packFormat,
    platform: entry.canonicalPlatform,
    rawBytes: 0,
    sha256: entry.packSha256,
    slug: entry.packSlug,
    source: entry.source,
  } satisfies IdentifySystem;
};

const databaseRequirementFor = (platform: string): IdentifyDatabaseRequirement => ({
  hint: `Identifying ${platform} ROMs needs the ${platform} database. Download it from the identification database manager.`,
  platform,
});

const isHasheousPackAvailable = async (system: IdentifySystem): Promise<boolean> => {
  if (readIdentifyDatabaseSettings().hasheousConsent) return true;
  const stored = await getDefaultIdentifyPackStore()
    .get(system.file)
    .catch(() => undefined);
  // A stored pack for a superseded hash is NOT available: without consent it
  // cannot be refreshed, so the run must report database_required rather than
  // fail on the checksum gate.
  return stored !== undefined && (!system.sha256 || stored.sha256 === system.sha256);
};

/**
 * Load the packs an input could match. Throws {@link IdentifyDataUnavailableError}
 * when the database - not the ROM - is the problem. A routed Hasheous platform
 * whose pack is neither cached nor permitted to download does not throw: it is
 * reported as `databaseRequired`, so identify can still answer for the packs
 * that did load and the UI can point at the manager.
 */
const loadIdentifyPackSelection = async (
  hints: IdentifyPackHints,
  /** Reports the human platform names about to be fetched, for stage progress. */
  onSelected?: (platforms: string[]) => void,
): Promise<IdentifyPackSelection> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const selected = selectIdentifySlugs(hints, catalog);
  let databaseRequired: IdentifyDatabaseRequirement | undefined;
  let systems: IdentifySystem[];
  if (selected.length) {
    systems = [];
    for (const slug of selected) {
      const system = systemForSlug(index, catalog, slug);
      if (!system) continue;
      if (system.source === "hasheous" && !(await isHasheousPackAvailable(system))) {
        // The FIRST blocked platform names the requirement; identify still runs
        // with whatever else was routed.
        databaseRequired ??= databaseRequirementFor(system.platform);
        continue;
      }
      systems.push(system);
    }
  } else {
    // The unnarrowed fallback loads the full self-hosted set plus only the
    // Hasheous packs already downloaded. It never triggers a bulk network
    // download of every dynamic platform.
    const storedFiles = new Set(
      (
        await getDefaultIdentifyPackStore()
          .keys()
          .catch(() => [])
      ).map((key) => key.fileName),
    );
    systems = index.systems.filter((system) => system.source !== "hasheous" || storedFiles.has(system.file));
    for (const entry of catalog?.platforms ?? []) {
      if (entry.source !== "hasheous") continue;
      const file = `${entry.packSlug}.pack`;
      if (!storedFiles.has(file) || systems.some((system) => system.slug === entry.packSlug)) continue;
      const system = systemForSlug(index, catalog, entry.packSlug);
      if (system) systems.push(system);
    }
  }
  if (!systems.length) {
    if (databaseRequired) return { databaseRequired, packs: [] };
    throw new IdentifyDataUnavailableError("The ROM identify index lists no usable database");
  }
  onSelected?.(systems.map((system) => system.platform));
  const packs = await Promise.all(systems.map(loadPack));
  return { ...(databaseRequired ? { databaseRequired } : {}), packs };
};

/** Back-compat wrapper over {@link loadIdentifyPackSelection} that returns the packs alone. */
const loadIdentifyPacks = async (
  hints: IdentifyPackHints,
  onSelected?: (platforms: string[]) => void,
): Promise<BrowserIdentifyPack[]> => (await loadIdentifyPackSelection(hints, onSelected)).packs;

/**
 * The manager's view of index.json + catalog.json, on the shared cached
 * promises so the manager and the identify flow always agree.
 */
const loadIdentifyCatalogIndex = async (): Promise<{
  catalog?: IdentifyCatalog;
  systems: Array<{ file: string; rawBytes?: number; sha256?: string; slug: string }>;
}> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  return {
    ...(catalog ? { catalog } : {}),
    systems: index.systems.map((system) => ({
      file: system.file,
      rawBytes: system.rawBytes,
      sha256: system.sha256,
      slug: system.slug,
    })),
  };
};

export {
  IdentifyDataUnavailableError,
  loadIdentifyCatalogIndex,
  loadIdentifyPacks,
  loadIdentifyPackSelection,
  resetIdentifyPackCache,
  selectIdentifySlugs,
};
export type { BrowserIdentifyPack };
