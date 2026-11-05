import { clonePatchFile, getPatchFileCleanup, replacePatchFileCleanup } from "../input/binary-service.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { inheritSourceIdentificationPolicy } from "../input/input-identification-policy.ts";
import { releasePreparedFile } from "./staged-source-cleanup.ts";

/** Ad-hoc properties that preparation and ingest attach to a prepared file and `clonePatchFile` does not copy. */
const PREPARED_FILE_STATE_KEYS = [
  "checksumVariants",
  "checksums",
  "identification",
  "identifyRetry",
  "metadata",
  "romType",
  "_precomputedChecksumMs",
] as const;

const copyPreparedFileState = (from: object, to: object) => {
  for (const key of PREPARED_FILE_STATE_KEYS) {
    const value = (from as Record<string, unknown>)[key];
    if (value !== undefined) (to as Record<string, unknown>)[key] = value;
  }
  inheritSourceIdentificationPolicy(from, to);
};

type SharedEntry = {
  /** Live holders per asset; an asset's prepared copy is cleaned up when its count reaches zero. */
  counts: number[];
  masters: InputAsset[];
};

/** Shares one prepared copy of a source (matched by object identity) between workflows and deletes it when the last holder releases its clone. */
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
      for (const asset of assets) releasePreparedFile(asset.file);
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
      copyPreparedFileState(master.file, file);
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

export { SharedInputPreparationCache };
