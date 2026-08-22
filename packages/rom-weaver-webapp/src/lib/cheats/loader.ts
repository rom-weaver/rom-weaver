import workerUrl from "./cheat-database.worker.ts?worker&url";
import type { CheatDatabaseManifest, CheatDatabaseSystem, CheatSystemShard } from "./model.ts";

type WorkerRequest = { id: number; url: string; system: CheatDatabaseSystem };
type WorkerResponse = { id: number; shard?: CheatSystemShard; error?: string };

const sameOriginUrl = (path: string, origin: string): URL => {
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error("Cheat database assets must use the app origin.");
  return url;
};

export const loadCheatDatabaseManifest = async (
  path = "/cheats/manifest.json",
  fetcher: typeof fetch = fetch,
): Promise<CheatDatabaseManifest> => {
  const url = sameOriginUrl(path, globalThis.location.origin);
  const response = await fetcher(url, { cache: "default", credentials: "same-origin" });
  if (!response.ok) throw new Error(`The cheat database manifest returned HTTP ${response.status}.`);
  const manifest = (await response.json()) as Partial<CheatDatabaseManifest>;
  if (manifest.schemaVersion !== 1 || !manifest.systems || !manifest.sourceRevision) {
    throw new Error("The cheat database manifest has an invalid schema.");
  }
  return manifest as CheatDatabaseManifest;
};

export interface CheatDatabaseClient {
  loadSystem(system: CheatDatabaseSystem): Promise<CheatSystemShard>;
  close(): void;
}

export const createCheatDatabaseClient = (
  manifest: CheatDatabaseManifest,
  createWorker: () => Worker = () => new Worker(workerUrl, { name: "rom-weaver-cheat-database", type: "module" }),
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
    loadSystem(system) {
      const entry = manifest.systems[system];
      if (!entry) return Promise.reject(new Error(`The cheat database does not include ${system}.`));
      const url = sameOriginUrl(entry.path, globalThis.location.origin).href;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        getWorker().postMessage({ id, url, system } satisfies WorkerRequest);
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

export { sameOriginUrl };
