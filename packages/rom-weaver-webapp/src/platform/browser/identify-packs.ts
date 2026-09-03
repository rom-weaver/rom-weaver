/**
 * Fetches the per-system identify packs the browser stages for the wasm ingest
 * command. Three properties matter here:
 *
 * 1. A pack that cannot be fetched, sized, or hashed is an UNAVAILABLE database,
 *    never a silent "no match". Callers get {@link IdentifyDataUnavailableError}
 *    so the UI can say so and offer a retry.
 * 2. The service worker installs every pack before use. This module reads only
 *    the packs a ROM could plausibly match into memory.
 * 3. Libretro and OpenGood data ships with the app and uses same-origin URLs.
 */
import {
  findCatalogPlatformBySlug,
  parseIdentifyCatalog,
  resolveCatalogPlatform,
} from "../../lib/identify/identify-catalog.ts";
import type { IdentifyCatalog } from "../../lib/identify/identify-catalog.ts";
import { sha256Hex } from "../../lib/identify/sha256-hex.ts";
import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("identify-packs");

type IdentifySystem = {
  brotliBytes?: number;
  brotliFile?: string;
  file: string;
  packFormat?: string;
  platform: string;
  rawBytes: number;
  sha256: string;
  slug: string;
  source: string;
  group?: string;
};

/** Mirrors the worker's IdentifyGroupState reply (see offline-warmup.ts). */
type IdentifyPackGroupState = {
  id: string;
  installed: boolean;
  label: string;
  packs: number;
  sizeBytes: number;
  wanted: boolean;
};

type IdentifyPackGroup = {
  default: boolean;
  id: string;
  label: string;
  systems: string[];
};

type IdentifyIndex = {
  catalog?: string;
  format: string;
  /** Upstream database revisions, logged so a page and a worker can be compared. */
  sources?: Record<string, { revision?: string; release?: string }>;
  groups?: IdentifyPackGroup[];
  packGroups?: IdentifyPackGroup[];
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

type IdentifyPackSelection = {
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
  // 3DS extensions mirror the z3ds container subtype table
  // (`crates/rom-weaver-containers/src/handlers/z3ds.rs`): each raw payload
  // extension plus its compressed `.z*` twin.
  "3ds": ["nintendo-nintendo-3ds"],
  "3dsx": ["nintendo-nintendo-3ds"],
  a26: ["atari-2600"],
  a52: ["atari-5200"],
  a78: ["atari-7800"],
  cci: ["nintendo-nintendo-3ds"],
  cia: ["nintendo-nintendo-3ds"],
  cxi: ["nintendo-nintendo-3ds"],
  fig: ["nintendo-super-nintendo-entertainment-system"],
  gb: ["nintendo-game-boy"],
  gba: ["nintendo-game-boy-advance"],
  gbc: ["nintendo-game-boy-color"],
  gen: ["sega-mega-drive-genesis"],
  gg: ["sega-game-gear"],
  lnx: ["atari-lynx"],
  md: ["sega-mega-drive-genesis"],
  n64: ["nintendo-nintendo-64"],
  nes: ["nintendo-nintendo-entertainment-system"],
  ngc: ["snk-neo-geo-pocket-color"],
  ngp: ["snk-neo-geo-pocket"],
  pce: ["nec-pc-engine-turbografx-16"],
  sfc: ["nintendo-super-nintendo-entertainment-system"],
  sgx: ["nec-pc-engine-turbografx-16"],
  smc: ["nintendo-super-nintendo-entertainment-system"],
  smd: ["sega-mega-drive-genesis"],
  sms: ["sega-master-system-mark-iii"],
  swc: ["nintendo-super-nintendo-entertainment-system"],
  unf: ["nintendo-nintendo-entertainment-system"],
  unif: ["nintendo-nintendo-entertainment-system"],
  v64: ["nintendo-nintendo-64"],
  z3ds: ["nintendo-nintendo-3ds"],
  z3dsx: ["nintendo-nintendo-3ds"],
  z64: ["nintendo-nintendo-64"],
  zcci: ["nintendo-nintendo-3ds"],
  zcia: ["nintendo-nintendo-3ds"],
  zcxi: ["nintendo-nintendo-3ds"],
};

const CARTRIDGE_FALLBACK_SLUGS = new Set(Object.values(PLATFORM_BY_EXTENSION).flat());

/**
 * Header detection cannot separate these siblings - a Game Boy Color cartridge
 * carries a Game Boy header, a Game Gear ROM carries an SMS header (see
 * `platform_detection::platform_for_rom_header`). Widening a detected slug to
 * its whole family keeps a correct match reachable; a wrong sibling simply
 * yields no CRC32 hit.
 */
const SIBLING_SLUGS: Record<string, string[]> = {
  "snk-neo-geo-pocket": ["snk-neo-geo-pocket-color"],
  "snk-neo-geo-pocket-color": ["snk-neo-geo-pocket"],
  "nintendo-game-boy": ["nintendo-game-boy-color"],
  "nintendo-game-boy-color": ["nintendo-game-boy"],
  "sega-32x": ["sega-mega-drive-genesis"],
  "sega-game-gear": ["sega-master-system-mark-iii"],
  "sega-master-system-mark-iii": ["sega-game-gear"],
  "sega-mega-drive-genesis": ["sega-32x"],
  // A PlayStation-family disc whose SYSTEM.CNF lies beyond the probe's bounded
  // prefix is split from its sibling only by framing and size, and PS2 shipped
  // CD titles too - keep both packs in play.
  "sony-playstation": ["sony-playstation-2"],
  "sony-playstation-2": ["sony-playstation"],
};

/** Mirrors the platform slug builder used by the identify data scripts. */
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
 * empty result means "cannot be narrowed". The caller falls back to cartridge
 * packs because an unknown raw file cannot provide a usable optical
 * media profile. A detected platform name also routes through catalog aliases.
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

/** Drop every cached index, catalog, and pack promise so a retry rereads local assets. */
const resetIdentifyPackCache = () => {
  indexPromise = undefined;
  catalogPromise = undefined;
  packPromises.clear();
};

// The index is the first thing a lookup touches, so a failure here is a lookup
// that never reaches a pack and logs nothing else. Every exit logs what the
// response actually was: a served index and a cached one that disagree are the
// difference between an origin problem and this device's stored copy.
const describeIndexResponse = (response: Response) => ({
  contentType: response.headers.get("content-type") || "none",
  redirected: response.redirected,
  status: response.status,
  url: response.url,
});

const loadIndex = async (): Promise<IdentifyIndex> => {
  const requestUrl = assetUrl("index.json");
  let response: Response;
  try {
    response = await fetch(requestUrl, { cache: "no-cache" });
  } catch (cause) {
    logger.error("identify index request failed", { error: describe(cause), url: requestUrl.href });
    throw new IdentifyDataUnavailableError(`ROM identify index request failed: ${describe(cause)}`, { cause });
  }
  if (!response.ok) {
    logger.error("identify index request failed", describeIndexResponse(response));
    throw new IdentifyDataUnavailableError(`ROM identify index request failed with HTTP ${response.status}`);
  }
  let index: Partial<IdentifyIndex>;
  try {
    index = (await response.json()) as Partial<IdentifyIndex>;
  } catch (cause) {
    logger.error("identify index is not valid JSON", { error: describe(cause), ...describeIndexResponse(response) });
    throw new IdentifyDataUnavailableError(`ROM identify index is not valid JSON: ${describe(cause)}`, { cause });
  }
  if (index.format !== "rom-weaver-identify-system-pack-v1" || !Array.isArray(index.systems)) {
    // The shape says which document arrived. Valid JSON of the wrong shape is a
    // different file, not a corrupt one - a catalog, an app manifest, or an
    // index from a build that predates this format.
    logger.error("identify index is invalid", {
      format: typeof index.format === "string" ? index.format : `[${typeof index.format}]`,
      keys: Object.keys(index).join(" ") || "none",
      systems: Array.isArray(index.systems) ? index.systems.length : `[${typeof index.systems}]`,
      ...describeIndexResponse(response),
    });
    throw new IdentifyDataUnavailableError("ROM identify index is invalid");
  }
  logger.debug("identify index loaded", {
    sources: Object.entries(index.sources || {})
      .map(([name, source]) => `${name}@${source?.revision || source?.release || "unknown"}`)
      .join(" "),
    systems: index.systems.length,
  });
  return index as IdentifyIndex;
};

/**
 * Load catalog.json when the deployment ships one. A missing or invalid
 * catalog degrades to index-only routing, so
 * every failure resolves to `undefined` instead of throwing.
 */
const loadCatalog = async (): Promise<IdentifyCatalog | undefined> => {
  try {
    const response = await fetch(assetUrl("catalog.json"), { cache: "no-cache" });
    if (!response.ok) {
      logger.debug("identify catalog unavailable", describeIndexResponse(response));
      return undefined;
    }
    return parseIdentifyCatalog(await response.json());
  } catch (cause) {
    // Index-only routing still answers, so this stays a degraded path, not a
    // failure - but it MUST leave a trace, or the narrowing silently changes.
    logger.debug("identify catalog unavailable", { error: describe(cause) });
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

const identifyPackGroups = (index: IdentifyIndex): IdentifyPackGroup[] => {
  const groups = index.groups ?? index.packGroups ?? [];
  return groups.filter(
    (group) =>
      typeof group?.id === "string" &&
      Array.isArray(group.systems) &&
      group.systems.every((slug) => typeof slug === "string"),
  );
};

const listOptionalIdentifyPackGroups = async (): Promise<IdentifyPackGroup[]> =>
  identifyPackGroups(await getIndex()).filter((group) => !group.default);

/**
 * Optional pack group ids whose systems overlap the selection the hints
 * produce. Used to bump those groups to the front of the offline warm-up when
 * an identify run starts. An unnarrowed selection bumps nothing - the
 * cartridge fallback only touches default packs.
 */
const identifyGroupIdsForHints = async (hints: IdentifyPackHints): Promise<string[]> => {
  try {
    const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
    const selected = new Set(selectIdentifySlugs(hints, catalog));
    if (!selected.size) return [];
    return identifyPackGroups(index)
      .filter((group) => !group.default && group.systems.some((slug) => selected.has(slug)))
      .map((group) => group.id);
  } catch {
    return [];
  }
};

/** Ask the worker which optional groups are kept offline and which are stored. */
const getIdentifyPackGroupState = async (): Promise<IdentifyPackGroupState[]> =>
  requestIdentifyGroupState({ action: "get-identify-pack-group-state" });

/** Tick or untick a group. Unticking deletes what that group cached. */
const setIdentifyPackGroupWanted = async (groupId: string, wanted: boolean): Promise<IdentifyPackGroupState[]> =>
  requestIdentifyGroupState({ action: "set-identify-pack-group-wanted", groupId, wanted });

const requestIdentifyGroupState = (message: Record<string, unknown>): Promise<IdentifyPackGroupState[]> => {
  const controller = navigator.serviceWorker?.controller;
  if (!controller || typeof MessageChannel !== "function") {
    throw new IdentifyDataUnavailableError("The service worker cannot manage ROM identify packs");
  }
  return new Promise<IdentifyPackGroupState[]>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      if (event.data?.action === "identify-pack-group-state" && Array.isArray(event.data.groups)) {
        resolve(event.data.groups as IdentifyPackGroupState[]);
      } else {
        reject(new IdentifyDataUnavailableError(event.data?.error || "Could not read ROM identify pack settings"));
      }
    };
    controller.postMessage(message, [channel.port2]);
  });
};

const installIdentifyPackGroup = async (groupId: string): Promise<void> => {
  const group = (await listOptionalIdentifyPackGroups()).find((candidate) => candidate.id === groupId);
  if (!group) throw new IdentifyDataUnavailableError(`Unknown ROM identify pack group: ${groupId}`);
  const controller = navigator.serviceWorker?.controller;
  if (!controller || typeof MessageChannel !== "function") {
    throw new IdentifyDataUnavailableError("The service worker cannot install ROM identify packs");
  }
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      if (event.data?.action === "identify-pack-group-installed") resolve();
      else reject(new IdentifyDataUnavailableError(event.data?.error || `Could not install ${group.label}`));
    };
    controller.postMessage({ action: "install-identify-pack-group", groupId }, [channel.port2]);
  });
};

/** Verified pack bytes -> the staged blob shape the wasm runtime consumes. */
const toBrowserPack = (system: IdentifySystem, bytes: ArrayBuffer): BrowserIdentifyPack => ({
  blob: new Blob([bytes], { type: "application/octet-stream" }),
  fileName: system.file,
  platform: system.platform,
  slug: system.slug,
});

const verifyPackBytes = async (system: IdentifySystem, bytes: ArrayBuffer): Promise<void> => {
  // Size and SHA-256 both gate the pack. A truncated or substituted database
  // MUST NOT reach the parser. A catalog-only pack has no indexed size.
  //
  // Both failures log the expected and the actual value. Without them a stale
  // service worker serving a previous data revision and a truncated body read
  // identically, and the served bytes are the only evidence either way.
  if (system.rawBytes > 0 && bytes.byteLength !== system.rawBytes) {
    logger.error("identify pack size mismatch", {
      actualBytes: bytes.byteLength,
      expectedBytes: system.rawBytes,
      file: system.file,
    });
    throw new IdentifyDataUnavailableError(`ROM identify database size is invalid: ${system.file}`);
  }
  if (!system.sha256) return;
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== system.sha256) {
    logger.error("identify pack checksum mismatch", {
      actualSha256,
      bytes: bytes.byteLength,
      expectedSha256: system.sha256,
      file: system.file,
    });
    throw new IdentifyDataUnavailableError(`ROM identify database checksum is invalid: ${system.file}`);
  }
};

const packUrl = (system: IdentifySystem): URL => {
  const url = assetUrl(system.file);
  if (system.sha256) url.searchParams.set("sha256", system.sha256);
  return url;
};

const fetchPackBytes = async (system: IdentifySystem): Promise<ArrayBuffer> => {
  const url = packUrl(system);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    logger.error("identify pack request failed", { error: describe(cause), file: system.file, url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify database request failed: ${system.file}: ${describe(cause)}`, {
      cause,
    });
  }
  if (!response.ok) {
    logger.error("identify pack request failed", { file: system.file, status: response.status, url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify database request failed with HTTP ${response.status}`);
  }
  return response.arrayBuffer();
};

const loadPack = (system: IdentifySystem): Promise<BrowserIdentifyPack> => {
  const existing = packPromises.get(system.file);
  if (existing) return existing;
  const pending = (async () => {
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
    brotliFile: `${entry.packSlug}.pack.br`,
    file: `${entry.packSlug}.pack`,
    packFormat: entry.packFormat,
    platform: entry.canonicalPlatform,
    rawBytes: 0,
    sha256: entry.packSha256,
    slug: entry.packSlug,
    source: entry.source,
  } satisfies IdentifySystem;
};

/**
 * Load the packs an input could match. Throws {@link IdentifyDataUnavailableError}
 * when the database - not the ROM - is the problem.
 */
const loadIdentifyPackSelection = async (
  hints: IdentifyPackHints,
  /** Reports the human platform names about to be fetched, for stage progress. */
  onSelected?: (platforms: string[]) => void,
): Promise<IdentifyPackSelection> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const selected = selectIdentifySlugs(hints, catalog);
  let systems: IdentifySystem[];
  if (selected.length) {
    systems = [];
    const unmatched: string[] = [];
    for (const slug of selected) {
      const system = systemForSlug(index, catalog, slug);
      if (!system) {
        unmatched.push(slug);
        continue;
      }
      systems.push(system);
    }
    logger.debug("identify pack selection", {
      hints: [hints.platform ? `platform=${hints.platform}` : "", hints.fileName ? `file=${hints.fileName}` : ""]
        .filter(Boolean)
        .join(" "),
      selected: selected.join(" "),
      source: "hints",
      ...(unmatched.length ? { unmatched: unmatched.join(" ") } : {}),
    });
  } else {
    // Generic cartridge files often have no useful extension or header. Keep
    // the bounded cartridge fallback, but do not load every optical pack.
    systems = index.systems.filter((system) => CARTRIDGE_FALLBACK_SLUGS.has(system.slug));
    // The whole fallback set has to load for one answer, so any single pack
    // failure fails the lookup. Name the set that is about to be fetched.
    logger.debug("identify pack selection", {
      packs: systems.length,
      selected: systems.map((system) => system.slug).join(" "),
      source: "cartridge-fallback",
    });
  }
  if (!systems.length) {
    logger.error("identify index lists no usable database", {
      indexSystems: index.systems.length,
      selected: selected.join(" ") || "none",
    });
    throw new IdentifyDataUnavailableError("The ROM identify index lists no usable database");
  }
  onSelected?.(systems.map((system) => system.platform));
  const packs = await Promise.all(systems.map(loadPack));
  return { packs };
};

/** Back-compat wrapper over {@link loadIdentifyPackSelection} that returns the packs alone. */
const loadIdentifyPacks = async (
  hints: IdentifyPackHints,
  onSelected?: (platforms: string[]) => void,
): Promise<BrowserIdentifyPack[]> => (await loadIdentifyPackSelection(hints, onSelected)).packs;

export {
  getIdentifyPackGroupState,
  identifyGroupIdsForHints,
  IdentifyDataUnavailableError,
  installIdentifyPackGroup,
  listOptionalIdentifyPackGroups,
  loadIdentifyPacks,
  loadIdentifyPackSelection,
  resetIdentifyPackCache,
  selectIdentifySlugs,
  setIdentifyPackGroupWanted,
};
export type { BrowserIdentifyPack, IdentifyPackGroupState };
