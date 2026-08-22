/// <reference lib="webworker" />

import type { CheatDatabaseSystem, CheatSystemShard } from "./model.ts";

const MAX_SHARD_BYTES = 128 * 1024 * 1024;
const MAX_GAMES = 100_000;
const MAX_CHEATS = 1_000_000;

type LoadRequest = { id: number; url: string; system: CheatDatabaseSystem };
type LoadResponse = { id: number; shard?: CheatSystemShard; error?: string };

const scope = self as DedicatedWorkerGlobalScope;

const parseShard = (text: string, system: CheatDatabaseSystem): CheatSystemShard => {
  if (text.length > MAX_SHARD_BYTES) throw new Error("The cheat database shard is too large.");
  const value = JSON.parse(text) as Partial<CheatSystemShard>;
  if (value.schemaVersion !== 1 || value.system !== system || !Array.isArray(value.games)) {
    throw new Error("The cheat database shard has an invalid schema.");
  }
  if (value.games.length > MAX_GAMES) throw new Error("The cheat database shard has too many games.");
  const cheatCount = value.games.reduce(
    (count, game) => count + (Array.isArray(game.cheats) ? game.cheats.length : 0),
    0,
  );
  if (cheatCount > MAX_CHEATS) throw new Error("The cheat database shard has too many cheats.");
  return value as CheatSystemShard;
};

scope.addEventListener("message", (event: MessageEvent<LoadRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const url = new URL(request.url, scope.location.origin);
      if (url.origin !== scope.location.origin) throw new Error("Cheat database shards must use the app origin.");
      const response = await fetch(url, { cache: "default", credentials: "same-origin" });
      if (!response.ok) throw new Error(`The cheat database shard returned HTTP ${response.status}.`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_SHARD_BYTES) throw new Error("The cheat database shard is too large.");
      const shard = parseShard(await response.text(), request.system);
      scope.postMessage({ id: request.id, shard } satisfies LoadResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cheat database shard could not load.";
      scope.postMessage({ id: request.id, error: message } satisfies LoadResponse);
    }
  })();
});
