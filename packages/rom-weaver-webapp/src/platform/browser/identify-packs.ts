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
};

const DATA_ROOT = "identify-data/v1/";
const PLATFORM_BY_EXTENSION: Record<string, string[]> = {
  "32x": ["sega-32x"],
  a26: ["atari-2600"],
  a52: ["atari-5200"],
  a78: ["atari-7800"],
  gb: ["nintendo-game-boy"],
  gba: ["nintendo-game-boy-advance"],
  gbc: ["nintendo-game-boy-color"],
  gg: ["sega-game-gear"],
  lnx: ["atari-lynx"],
  md: ["sega-mega-drive-genesis"],
  n64: ["nintendo-64"],
  nes: ["nintendo-entertainment-system"],
  ngc: ["neo-geo-pocket-color"],
  ngp: ["neo-geo-pocket"],
  pce: ["turbografx-16-pc-engine"],
  sfc: ["nintendo-super-nintendo-entertainment-system"],
  smc: ["nintendo-super-nintendo-entertainment-system"],
  sms: ["sega-master-system"],
  v64: ["nintendo-64"],
  z64: ["nintendo-64"],
};

const assetUrl = (name: string) => new URL(`${DATA_ROOT}${name}`, document.baseURI);
let indexPromise: Promise<IdentifyIndex> | undefined;
const packPromises = new Map<string, Promise<BrowserIdentifyPack>>();

const loadIndex = async (): Promise<IdentifyIndex> => {
  const response = await fetch(assetUrl("index.json"), { cache: "no-cache" });
  if (!response.ok) throw new Error(`ROM identify index request failed with HTTP ${response.status}`);
  const index = (await response.json()) as Partial<IdentifyIndex>;
  if (index.format !== "rom-weaver-identify-system-pack-v1" || !Array.isArray(index.systems)) {
    throw new Error("ROM identify index is invalid");
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
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ROM identify database request failed with HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== system.rawBytes) throw new Error(`ROM identify database size is invalid: ${system.file}`);
    if ((await sha256Hex(bytes)) !== system.sha256) {
      throw new Error(`ROM identify database checksum is invalid: ${system.file}`);
    }
    return {
      blob: new Blob([bytes], { type: "application/octet-stream" }),
      fileName: system.file,
      platform: system.platform,
    };
  })().catch((error) => {
    packPromises.delete(system.file);
    throw error;
  });
  packPromises.set(system.file, pending);
  return pending;
};

export const loadIdentifyPacks = async (fileName: string): Promise<BrowserIdentifyPack[]> => {
  if (!indexPromise) {
    indexPromise = loadIndex().catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  const index = await indexPromise;
  const extension = fileName.split(".").at(-1)?.toLowerCase() || "";
  const selected = PLATFORM_BY_EXTENSION[extension];
  const systems = selected?.length ? index.systems.filter((system) => selected.includes(system.slug)) : index.systems;
  if (!systems.length) throw new Error(`No ROM identify database supports .${extension || "unknown"} files`);
  return Promise.all(systems.map(loadPack));
};

export type { BrowserIdentifyPack };
