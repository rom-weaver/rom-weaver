import workerUrl from "./cheat-database.worker.ts?worker&url";
import {
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
  type CheatSystemShard,
  isCheatDatabaseSystem,
} from "./model.ts";

type WorkerRequest = { id: number; url: string; entry: CheatDatabaseEntry };
type WorkerResponse = { id: number; shard?: CheatSystemShard; error?: string };

/** Shards ship next to the identify packs under the same `assets/identify-` prefix. */
const CHEAT_ASSET_PREFIX = "assets/identify-";

/** The shard URL the service worker's pack table knows: file name plus the digest it verifies. */
const cheatShardUrl = (entry: CheatDatabaseEntry, base: string): URL => {
  const url = new URL(`${CHEAT_ASSET_PREFIX}${entry.file}`, base);
  if (url.origin !== new URL(base).origin) throw new Error("Cheat database assets must use the app origin.");
  url.searchParams.set("sha256", entry.sha256);
  return url;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseEntry = (value: unknown): CheatDatabaseEntry | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (!(isNonEmptyString(record.platform) && isNonEmptyString(record.slug) && isNonEmptyString(record.file))) {
    return undefined;
  }
  if (!isCheatDatabaseSystem(typeof record.cheatSystem === "string" ? record.cheatSystem : undefined)) return undefined;
  if (!(isCount(record.rawBytes) && /^[0-9a-f]{64}$/u.test(String(record.sha256)))) return undefined;
  if (record.file.includes("/") || record.file.includes("\\")) return undefined;
  return {
    platform: record.platform,
    slug: record.slug,
    cheatSystem: record.cheatSystem as CheatDatabaseEntry["cheatSystem"],
    file: record.file,
    rawBytes: record.rawBytes,
    sha256: String(record.sha256),
    games: isCount(record.games) ? record.games : 0,
    cheats: isCount(record.cheats) ? record.cheats : 0,
  };
};

/**
 * Read the cheat rows out of the identify index. An index without a `cheats`
 * array is a deployment that predates cheat data, which is "unavailable", not
 * "no cheats for this ROM", so it returns `undefined`.
 */
export const parseCheatDatabaseIndex = (index: unknown): CheatDatabaseIndex | undefined => {
  if (!index || typeof index !== "object") return undefined;
  const record = index as { cheats?: unknown; sources?: { libretro?: Record<string, unknown> } };
  if (!Array.isArray(record.cheats)) return undefined;
  const libretro = record.sources?.libretro;
  if (!(libretro && isNonEmptyString(libretro.revision) && isNonEmptyString(libretro.url))) return undefined;
  const entries = record.cheats.map(parseEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;
  return {
    sourceRevision: libretro.revision,
    sourceUrl: libretro.url,
    license: isNonEmptyString(libretro.license) ? libretro.license : "CC-BY-SA-4.0",
    entries: entries as CheatDatabaseEntry[],
  };
};

export interface CheatDatabaseClient {
  loadShard(entry: CheatDatabaseEntry): Promise<CheatSystemShard>;
  close(): void;
}

export const createCheatDatabaseClient = (
  createWorker: () => Worker = () => new Worker(workerUrl, { name: "rom-weaver-cheat-database", type: "module" }),
  base: string = document.baseURI,
): CheatDatabaseClient => {
  let nextId = 1;
  let worker: Worker | undefined;
  const pending = new Map<number, { resolve: (shard: CheatSystemShard) => void; reject: (error: Error) => void }>();

  const getWorker = (): Worker => {
    if (worker) return worker;
    worker = createWorker();
    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else if (event.data.shard) request.resolve(event.data.shard);
      else request.reject(new Error("The cheat database worker returned no shard."));
    });
    worker.addEventListener("error", () => {
      for (const request of pending.values()) request.reject(new Error("The cheat database worker stopped."));
      pending.clear();
    });
    return worker;
  };

  return {
    loadShard(entry) {
      let url: string;
      try {
        url = cheatShardUrl(entry, base).href;
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, url, entry } satisfies WorkerRequest);
      });
    },
    close() {
      worker?.terminate();
      worker = undefined;
      for (const request of pending.values()) request.reject(new Error("The cheat database client closed."));
      pending.clear();
    },
  };
};

export { cheatShardUrl };
