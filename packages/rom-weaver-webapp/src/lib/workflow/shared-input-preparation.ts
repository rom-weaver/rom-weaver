import { clonePatchFile, getPatchFileCleanup, replacePatchFileCleanup } from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";

type SharedEntry = {
  /** Live holders per asset; an asset's prepared copy is cleaned up when its count reaches zero. */
  counts: number[];
  masters: InputAsset[];
};

/**
 * Shares one prepared (extracted) copy of a source between workflows that stage it independently.
 * Each holder gets its own asset objects whose cleanup only releases its hold, so the prepared copy
 * is deleted when the last holder releases it. Sources are matched by object identity.
 */
class SharedInputPreparationCache {
  private readonly entries = new WeakMap<object, Map<string, SharedEntry>>();

  /** Assets for a live shared preparation of this source, or null when none exists. */
  lease(source: unknown, key: string): InputAsset[] | null {
    const entry = isObject(source) ? this.entries.get(source)?.get(key) : undefined;
    return entry ? this.cloneForHolder(source as object, key, entry) : null;
  }

  /**
   * Share freshly prepared assets and return the caller's own copy of them. Assets that carry
   * sidecar patches are returned as-is, because their patch files cannot be shared safely.
   */
  adopt(source: unknown, key: string, assets: InputAsset[]): InputAsset[] {
    if (!isObject(source)) return assets;
    if (!assets.length || assets.some((asset) => asset.sidecarPatches?.length)) return assets;
    const byKey = this.entries.get(source) ?? new Map<string, SharedEntry>();
    this.entries.set(source, byKey);
    const existing = byKey.get(key);
    if (existing) {
      releaseAll(assets);
      return this.cloneForHolder(source, key, existing);
    }
    const entry: SharedEntry = { counts: assets.map(() => 0), masters: assets };
    byKey.set(key, entry);
    return this.cloneForHolder(source, key, entry);
  }

  private cloneForHolder(source: object, key: string, entry: SharedEntry): InputAsset[] {
    return entry.masters.map((master, index) => {
      entry.counts[index] = (entry.counts[index] ?? 0) + 1;
      const file = clonePatchFile(master.file);
      replacePatchFileCleanup(file, () => this.release(source, key, entry, index));
      return { ...master, ...(master.checksums ? { checksums: { ...master.checksums } } : {}), file };
    });
  }

  private release(source: object, key: string, entry: SharedEntry, index: number): Promise<void> | void {
    entry.counts[index] = (entry.counts[index] ?? 1) - 1;
    if (entry.counts[index]) return;
    // One asset's copy is gone, so the entry can no longer be leased whole.
    const byKey = this.entries.get(source);
    if (byKey?.get(key) === entry) byKey.delete(key);
    const master = entry.masters[index];
    return master ? getPatchFileCleanup(master.file)?.() : undefined;
  }
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const releaseAll = (assets: InputAsset[]) => {
  for (const asset of assets) void Promise.resolve(getPatchFileCleanup(asset.file)?.()).catch(() => undefined);
};

export { SharedInputPreparationCache };
