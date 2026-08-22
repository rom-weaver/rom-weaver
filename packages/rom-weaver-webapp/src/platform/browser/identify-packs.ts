/**
 * Fetches the per-system identify packs the browser stages for the wasm ingest
 * command. Two properties matter here:
 *
 * 1. A pack that cannot be fetched, sized, or hashed is an UNAVAILABLE database,
 *    never a silent "no match". Callers get {@link IdentifyDataUnavailableError}
 *    so the UI can say so and offer a retry.
 * 2. Only the packs a ROM could plausibly match are downloaded. The whole set is
 *    6.7 MB raw, so loading it for every generic `.bin` would dwarf the work.
 */
type IdentifySystem = {
  file: string;
  platform: string;
  rawBytes: number;
  sha256: string;
  slug: string;
  source: string;
};

type IdentifyIndex = {
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
 * full set rather than skip a pack a ROM could have matched.
 */
const selectIdentifySlugs = ({ entryNames, fileName, platform }: IdentifyPackHints): string[] => {
  const slugs = new Set<string>();
  if (platform?.trim()) slugs.add(slugifyPlatform(platform));
  for (const name of [fileName || "", ...(entryNames || [])]) {
    for (const slug of PLATFORM_BY_EXTENSION[fileExtension(name)] || []) slugs.add(slug);
  }
  return withSiblings(slugs);
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const assetUrl = (name: string) => new URL(`${DATA_ROOT}${name}`, document.baseURI);
let indexPromise: Promise<IdentifyIndex> | undefined;
const packPromises = new Map<string, Promise<BrowserIdentifyPack>>();

/** Drop every cached index/pack promise so a retry refetches from the network. */
const resetIdentifyPackCache = () => {
  indexPromise = undefined;
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

const sha256Hex = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

const loadPack = (system: IdentifySystem): Promise<BrowserIdentifyPack> => {
  const existing = packPromises.get(system.file);
  if (existing) return existing;
  const pending = (async () => {
    const url = assetUrl(system.file);
    url.searchParams.set("sha256", system.sha256);
    let response: Response;
    try {
      response = await fetch(url);
    } catch (cause) {
      throw new IdentifyDataUnavailableError(
        `ROM identify database request failed: ${system.file}: ${describe(cause)}`,
        { cause },
      );
    }
    if (!response.ok) {
      throw new IdentifyDataUnavailableError(`ROM identify database request failed with HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    // Size and SHA-256 both gate the pack: a truncated or substituted database
    // MUST NOT reach the parser.
    if (bytes.byteLength !== system.rawBytes) {
      throw new IdentifyDataUnavailableError(`ROM identify database size is invalid: ${system.file}`);
    }
    if ((await sha256Hex(bytes)) !== system.sha256) {
      throw new IdentifyDataUnavailableError(`ROM identify database checksum is invalid: ${system.file}`);
    }
    return {
      blob: new Blob([bytes], { type: "application/octet-stream" }),
      fileName: system.file,
      platform: system.platform,
      slug: system.slug,
    };
  })().catch((error) => {
    packPromises.delete(system.file);
    throw error;
  });
  packPromises.set(system.file, pending);
  return pending;
};

/**
 * Load the packs an input could match. Throws {@link IdentifyDataUnavailableError}
 * when the database - not the ROM - is the problem.
 */
const loadIdentifyPacks = async (
  hints: IdentifyPackHints,
  /** Reports the human platform names about to be fetched, for stage progress. */
  onSelected?: (platforms: string[]) => void,
): Promise<BrowserIdentifyPack[]> => {
  if (!indexPromise) {
    indexPromise = loadIndex().catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  const index = await indexPromise;
  const selected = selectIdentifySlugs(hints);
  const systems = selected.length ? index.systems.filter((system) => selected.includes(system.slug)) : index.systems;
  if (!systems.length) throw new IdentifyDataUnavailableError("The ROM identify index lists no usable database");
  onSelected?.(systems.map((system) => system.platform));
  return Promise.all(systems.map(loadPack));
};

export { IdentifyDataUnavailableError, loadIdentifyPacks, resetIdentifyPackCache, selectIdentifySlugs };
export type { BrowserIdentifyPack };
