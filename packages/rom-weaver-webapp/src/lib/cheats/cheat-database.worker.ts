/// <reference lib="webworker" />

import { sha256Hex } from "../identify/sha256-hex.ts";
import type { CheatDatabaseEntry, CheatSystemShard } from "./model.ts";
import { expandCheatShard, type StoredShard, validateStoredShard } from "./shard-format.mjs";

const MAX_SHARD_BYTES = 128 * 1024 * 1024;
const MAX_GAMES = 100_000;
const MAX_CHEATS = 1_000_000;

type LoadRequest = { id: number; url: string; entry: CheatDatabaseEntry };
type LoadResponse = { id: number; shard?: CheatSystemShard; error?: string };

const scope = self as DedicatedWorkerGlobalScope;

/**
 * Parse the stored shard and expand it into full records. The expansion
 * hashes one SHA-256 per record for its ID, which is why it runs here and
 * not on the main thread.
 */
const parseShard = async (text: string, entry: CheatDatabaseEntry): Promise<CheatSystemShard> => {
  const value = JSON.parse(text) as Partial<StoredShard>;
  if (
    value.schemaVersion !== 1 ||
    value.system !== entry.cheatSystem ||
    typeof value.sourceRevision !== "string" ||
    !Array.isArray(value.games)
  ) {
    throw new Error("The cheat database shard has an invalid schema.");
  }
  if (value.games.length > MAX_GAMES) throw new Error("The cheat database shard has too many games.");
  const cheatCount = value.games.reduce(
    (count, game) => count + (Array.isArray(game.cheats) ? game.cheats.length : 0),
    0,
  );
  if (cheatCount > MAX_CHEATS) throw new Error("The cheat database shard has too many cheats.");
  const expanded = await expandCheatShard(validateStoredShard(value), sha256Hex);
  return expanded as CheatSystemShard;
};

scope.addEventListener("message", (event: MessageEvent<LoadRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const url = new URL(request.url, scope.location.origin);
      if (url.origin !== scope.location.origin) throw new Error("Cheat database shards must use the app origin.");
      if (request.entry.rawBytes > MAX_SHARD_BYTES) throw new Error("The cheat database shard is too large.");
      const response = await fetch(url, { cache: "default", credentials: "same-origin" });
      if (!response.ok) throw new Error(`The cheat database shard returned HTTP ${response.status}.`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_SHARD_BYTES) throw new Error("The cheat database shard is too large.");
      // The index records the bytes the build produced; a served file that
      // differs is a stale cache or a tampered asset, never data to trust.
      if (bytes.byteLength !== request.entry.rawBytes || (await sha256Hex(bytes)) !== request.entry.sha256) {
        throw new Error("The cheat database shard does not match its index digest.");
      }
      const shard = await parseShard(new TextDecoder().decode(bytes), request.entry);
      scope.postMessage({ id: request.id, shard } satisfies LoadResponse);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The cheat database shard could not load.";
      scope.postMessage({ id: request.id, error: message } satisfies LoadResponse);
    }
  })();
});
