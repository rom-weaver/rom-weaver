/**
 * Fetch and validate the same-origin identify packs selected for a lookup.
 * A failed pack fetch or validation MUST report unavailable data, not a ROM with no match.
 */
import {
  algorithmForHex,
  CHECKSUM_ROUTER_FORMAT,
  parseChecksumRouter,
  routeChecksums,
} from "../../lib/identify/checksum-router.mjs";
import { parseTitleIndex, TITLE_INDEX_FORMAT } from "../../lib/identify/title-index.mjs";
import {
  findCatalogPlatformBySlug,
  parseIdentifyCatalog,
  resolveCatalogPlatform,
} from "../../lib/identify/identify-catalog.ts";
import type { IdentifyCatalog } from "../../lib/identify/identify-catalog.ts";
import { sha256Hex } from "../../lib/identify/sha256-hex.ts";
import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("identify-packs");

/** One binary fuse filter per pack, so a bare checksum names the packs that may hold it. */
type ChecksumRouter = ReturnType<typeof parseChecksumRouter>;

/** `checksumRoutes` in index.json: the single router file and its verification data. */
type ChecksumRoutesEntry = {
  file: string;
  format?: string;
  packs?: number;
  rawBytes: number;
  sha256: string;
};

type LoadedTitleIndex = {
  blob: Blob;
  fileName: string;
};

/** `titleIndex` in index.json: the single title index file and its verification data. */
type TitleIndexEntry = {
  file: string;
  format?: string;
  packs?: number;
  rawBytes: number;
  sha256: string;
  titles?: number;
};

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
  defaultPack?: boolean;
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
  /** Cheat shards built beside the packs; parsed by lib/cheats/loader.ts. */
  cheats?: unknown[];
  checksumRoutes?: ChecksumRoutesEntry;
  titleIndex?: TitleIndexEntry;
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
  /** Digests of the input, by algorithm. Routed through the checksum router. */
  checksums?: Readonly<Record<string, string>>;
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

/** Usable digests from the hints, lowercased. Anything blank is dropped. */
/**
 * The supplied digests the router can answer for: crc32, md5, and sha1. Any
 * other digest (a sha256, a malformed value) MUST NOT reach the router, or its
 * silence would read as a definitive miss; such inputs fall through to the
 * ordinary selection and the identify command reports on them itself.
 */
const checksumDigests = ({ checksums }: IdentifyPackHints): string[] =>
  Object.values(checksums || {})
    .map((value) => value.trim().toLowerCase())
    .filter((value) => algorithmForHex(value) !== undefined);

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
  hints: IdentifyPackHints,
  catalog?: IdentifyCatalog,
  router?: ChecksumRouter,
): string[] => {
  const { entryNames, fileName, platform } = hints;
  const slugs = new Set<string>();
  if (platform?.trim()) {
    const catalogEntry = resolveCatalogPlatform(catalog, platform);
    slugs.add(catalogEntry ? catalogEntry.packSlug : slugifyPlatform(platform));
  }
  for (const name of [fileName || "", ...(entryNames || [])]) {
    for (const slug of PLATFORM_BY_EXTENSION[fileExtension(name)] || []) slugs.add(slug);
  }
  const selected = new Set(withSiblings(slugs));
  const digests = checksumDigests(hints);
  // Router results are never widened to siblings: every pack has its own
  // filter, so a sibling that could hold the key already answered for itself.
  if (router && digests.length) for (const slug of routeChecksums(router, digests)) selected.add(slug);
  return [...selected];
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const assetUrl = (name: string) => new URL(`${DATA_ROOT}${name}`, document.baseURI);
// The manifests are content-addressed: the build hashes their bytes into the file
// name, so a bundle always reads the manifest it was built against and the file
// can be cached as immutable like every other asset.
const manifestUrl = (file: string) => new URL(`assets/${file}`, document.baseURI);
let indexPromise: Promise<IdentifyIndex> | undefined;
let catalogPromise: Promise<IdentifyCatalog | undefined> | undefined;
let checksumRouterPromise: Promise<ChecksumRouter> | undefined;
let titleIndexPromise: Promise<LoadedTitleIndex> | undefined;
const packPromises = new Map<string, Promise<BrowserIdentifyPack>>();

/** Drop every cached index, catalog, and pack promise so a retry rereads local assets. */
const resetIdentifyPackCache = () => {
  indexPromise = undefined;
  catalogPromise = undefined;
  checksumRouterPromise = undefined;
  titleIndexPromise = undefined;
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
  const requestUrl = manifestUrl(__IDENTIFY_MANIFEST_FILES__.index);
  let response: Response;
  try {
    response = await fetch(requestUrl);
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
  const file = __IDENTIFY_MANIFEST_FILES__.catalog;
  if (!file) {
    logger.debug("identify catalog unavailable", { reason: "not built" });
    return undefined;
  }
  try {
    const response = await fetch(manifestUrl(file));
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

/** The identify index and catalog as one fetch, for consumers outside the identify run. */
const loadIdentifyIndexAndCatalog = async (): Promise<{
  index: IdentifyIndex;
  catalog: IdentifyCatalog | undefined;
}> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  return { index, catalog };
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

const defaultPackSlugs = (index: IdentifyIndex): Set<string> =>
  new Set([
    ...index.systems.filter((system) => system.defaultPack || system.group === "default").map((system) => system.slug),
    ...identifyPackGroups(index)
      .filter((group) => group.default)
      .flatMap((group) => group.systems),
  ]);

/**
 * Optional pack group ids whose systems overlap the selection the hints
 * produce. Used to bump those groups to the front of the offline warm-up when
 * an identify run starts. An unnarrowed selection bumps nothing - the
 * cartridge fallback only touches default packs.
 */
const identifyGroupIdsForHints = async (hints: IdentifyPackHints): Promise<string[]> => {
  try {
    const [index, catalog, router] = await Promise.all([
      getIndex(),
      getCatalog(),
      checksumDigests(hints).length ? getChecksumRouter() : undefined,
    ]);
    const selected = new Set(selectIdentifySlugs(hints, catalog, router));
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
 * Fetch, verify, and parse `checksum-routes.bin`. A checksum with no router is
 * an UNAVAILABLE database, never a narrowed search: an index without
 * `checksumRoutes` is an older deployment, and answering "no match" from it
 * would be a lie. Every filter slug MUST name a loadable pack.
 */
const loadChecksumRouter = async (): Promise<ChecksumRouter> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const routes = index.checksumRoutes;
  if (!routes?.file) {
    logger.error("identify index has no checksum router", { systems: index.systems.length });
    throw new IdentifyDataUnavailableError("The ROM identify index lists no checksum router");
  }
  if (routes.format !== CHECKSUM_ROUTER_FORMAT || !routes.sha256) {
    logger.error("checksum router index entry is invalid", {
      format: routes.format,
      hasSha256: Boolean(routes.sha256),
    });
    throw new IdentifyDataUnavailableError("The ROM identify checksum router entry is invalid");
  }
  const url = assetUrl(routes.file);
  if (routes.sha256) url.searchParams.set("sha256", routes.sha256);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    logger.error("checksum router request failed", { error: describe(cause), url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify checksum router request failed: ${describe(cause)}`, {
      cause,
    });
  }
  if (!response.ok) {
    logger.error("checksum router request failed", { status: response.status, url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify checksum router request failed with HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== routes.rawBytes) {
    logger.error("checksum router size mismatch", {
      actualBytes: bytes.byteLength,
      expectedBytes: routes.rawBytes,
      file: routes.file,
    });
    throw new IdentifyDataUnavailableError(`ROM identify checksum router size is invalid: ${routes.file}`);
  }
  if (routes.sha256) {
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== routes.sha256) {
      logger.error("checksum router checksum mismatch", {
        actualSha256,
        expectedSha256: routes.sha256,
        file: routes.file,
      });
      throw new IdentifyDataUnavailableError(`ROM identify checksum router checksum is invalid: ${routes.file}`);
    }
  }
  let router: ChecksumRouter;
  try {
    router = parseChecksumRouter(new Uint8Array(bytes));
  } catch (cause) {
    logger.error("checksum router is invalid", { error: describe(cause), file: routes.file });
    throw new IdentifyDataUnavailableError(`ROM identify checksum router is invalid: ${describe(cause)}`, { cause });
  }
  const unknown = router.packs.filter((pack) => !systemForSlug(index, catalog, pack.slug)).map((pack) => pack.slug);
  if (unknown.length) {
    logger.error("checksum router names unknown packs", { file: routes.file, unknown: unknown.join(" ") });
    throw new IdentifyDataUnavailableError(`ROM identify checksum router names unknown packs: ${unknown.join(" ")}`);
  }
  logger.debug("checksum router loaded", { bytes: bytes.byteLength, packs: router.packs.length });
  return router;
};

const getChecksumRouter = (): Promise<ChecksumRouter> => {
  if (!checksumRouterPromise) {
    checksumRouterPromise = loadChecksumRouter().catch((error) => {
      checksumRouterPromise = undefined;
      throw error;
    });
  }
  return checksumRouterPromise;
};

/**
 * Fetch, verify, and parse `title-index.json`. A name search with no index is
 * an UNAVAILABLE database, never an empty result: an index without
 * `titleIndex` is an older deployment, and answering "no match" from it would
 * be a lie. Every pack slug the file names MUST name a loadable pack.
 */
const loadTitleIndex = async (): Promise<LoadedTitleIndex> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const entry = index.titleIndex;
  if (!entry?.file) {
    logger.error("identify index has no title index", { systems: index.systems.length });
    throw new IdentifyDataUnavailableError("The ROM identify index lists no title index");
  }
  if (entry.format !== TITLE_INDEX_FORMAT || !entry.sha256) {
    logger.error("title index entry is invalid", { format: entry.format, hasSha256: Boolean(entry.sha256) });
    throw new IdentifyDataUnavailableError("The ROM identify title index entry is invalid");
  }
  const url = assetUrl(entry.file);
  url.searchParams.set("sha256", entry.sha256);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    logger.error("title index request failed", { error: describe(cause), url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify title index request failed: ${describe(cause)}`, { cause });
  }
  if (!response.ok) {
    logger.error("title index request failed", { status: response.status, url: url.href });
    throw new IdentifyDataUnavailableError(`ROM identify title index request failed with HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== entry.rawBytes) {
    logger.error("title index size mismatch", {
      actualBytes: bytes.byteLength,
      expectedBytes: entry.rawBytes,
      file: entry.file,
    });
    throw new IdentifyDataUnavailableError(`ROM identify title index size is invalid: ${entry.file}`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== entry.sha256) {
    logger.error("title index checksum mismatch", {
      actualSha256,
      expectedSha256: entry.sha256,
      file: entry.file,
    });
    throw new IdentifyDataUnavailableError(`ROM identify title index checksum is invalid: ${entry.file}`);
  }
  let parsed: ReturnType<typeof parseTitleIndex>;
  try {
    parsed = parseTitleIndex(new TextDecoder().decode(bytes));
  } catch (cause) {
    logger.error("title index is invalid", { error: describe(cause), file: entry.file });
    throw new IdentifyDataUnavailableError(`ROM identify title index is invalid: ${describe(cause)}`, { cause });
  }
  const unknown = parsed.packs.filter((slug) => !systemForSlug(index, catalog, slug));
  if (unknown.length) {
    logger.error("title index names unknown packs", { file: entry.file, unknown: unknown.join(" ") });
    throw new IdentifyDataUnavailableError(`ROM identify title index names unknown packs: ${unknown.join(" ")}`);
  }
  logger.debug("title index loaded", {
    bytes: bytes.byteLength,
    packs: parsed.packs.length,
    titles: parsed.titles.length,
  });
  // System names MUST come from the same catalog that labels the results.
  // Enrich the verified index once so older data also supports system queries.
  const systems = parsed.packs.map((slug) => {
    const system = systemForSlug(index, catalog, slug);
    const platform = findCatalogPlatformBySlug(catalog, slug);
    return [...new Set([slug, system?.platform, platform?.canonicalPlatform, ...(platform?.aliases ?? [])])].filter(
      (name): name is string => Boolean(name),
    );
  });
  const defaults = defaultPackSlugs(index);
  const searchable = JSON.stringify({
    format: TITLE_INDEX_FORMAT,
    packs: parsed.packs,
    defaultPacks: parsed.packs.map((slug) => defaults.has(slug)),
    systems,
    titles: parsed.titles.map((title) => [title.name, title.packs]),
  });
  return { blob: new Blob([searchable], { type: "application/json" }), fileName: entry.file };
};

const getTitleIndex = (): Promise<LoadedTitleIndex> => {
  if (!titleIndexPromise) {
    titleIndexPromise = loadTitleIndex().catch((error) => {
      titleIndexPromise = undefined;
      throw error;
    });
  }
  return titleIndexPromise;
};

/** One title hit: the base title and the one pack it was found in. */
type IdentifyTitleHit = {
  name: string;
  platform: string;
  slug: string;
};

/** Validate the title index and attach catalog system names before WASM stages it. */
const loadIdentifyTitleIndex = async (onProgress?: (progress: { message?: string }) => void) => {
  if (!titleIndexPromise) onProgress?.({ message: "Loading the game titles…" });
  return getTitleIndex();
};

const mapIdentifyTitleSearchMatches = async (
  matches: Array<{ name: string; slugs: string[]; score: number }>,
): Promise<IdentifyTitleHit[]> => {
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const defaults = defaultPackSlugs(index);
  const rows: Array<{ hit: IdentifyTitleHit; score: number; defaultPack: boolean }> = [];
  for (const match of matches) {
    for (const slug of match.slugs) {
      const system = systemForSlug(index, catalog, slug);
      if (!system) throw new IdentifyDataUnavailableError(`ROM identify title index names unknown pack: ${slug}`);
      rows.push({
        hit: { name: match.name, platform: system.platform, slug },
        score: match.score,
        defaultPack: defaults.has(slug),
      });
    }
  }
  rows.sort((left, right) => right.score - left.score || Number(right.defaultPack) - Number(left.defaultPack));
  return rows.map((row) => row.hit);
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
  const digests = checksumDigests(hints);
  const [index, catalog, router] = await Promise.all([
    getIndex(),
    getCatalog(),
    digests.length ? getChecksumRouter() : undefined,
  ]);
  const selected = selectIdentifySlugs(hints, catalog, router);
  if (!selected.length && router) {
    // The filters cover every pack, so no hit is a definitive miss - not a
    // broken index, and not a reason to load the cartridge fallback.
    logger.debug("checksum router selected no pack", { digests: digests.join(" ") });
    return { packs: [] };
  }
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

/**
 * The single pack a chosen platform owns, by catalog pack slug or by any
 * platform name the catalog aliases. Sibling widening MUST NOT apply here: a
 * name search that pulled a family would load megabytes the user did not ask
 * for, and the platform is an explicit choice rather than a header guess.
 */
const loadIdentifyPackForPlatform = async (
  platform: string,
  onSelected?: (platforms: string[]) => void,
): Promise<BrowserIdentifyPack> => {
  const wanted = platform.trim();
  if (!wanted) throw new IdentifyDataUnavailableError("A platform is required to search the ROM identify data by name");
  const [index, catalog] = await Promise.all([getIndex(), getCatalog()]);
  const resolved = resolveCatalogPlatform(catalog, wanted);
  let system: IdentifySystem | undefined;
  for (const slug of [resolved?.packSlug, wanted, slugifyPlatform(wanted)]) {
    if (!slug) continue;
    system = systemForSlug(index, catalog, slug);
    if (system) break;
  }
  if (!system) {
    logger.error("identify index has no database for platform", { indexSystems: index.systems.length, platform });
    throw new IdentifyDataUnavailableError(`The ROM identify index has no database for ${wanted}`);
  }
  logger.debug("identify pack selection", { selected: system.slug, source: "platform" });
  onSelected?.([system.platform]);
  return loadPack(system);
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
  loadIdentifyPackForPlatform,
  loadIdentifyIndexAndCatalog,
  loadIdentifyPacks,
  loadIdentifyPackSelection,
  resetIdentifyPackCache,
  loadIdentifyTitleIndex,
  mapIdentifyTitleSearchMatches,
  selectIdentifySlugs,
  setIdentifyPackGroupWanted,
};
export type { BrowserIdentifyPack, IdentifyPackGroupState, IdentifyTitleHit };
