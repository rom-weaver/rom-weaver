import { getPatchFileCleanup } from "../input/binary-service.ts";
import type { InputAsset, InputParentCompression } from "../input/input-assets.ts";
import type { SharedParentCompression, SharedRomSourceState, SharedRomStagedSource } from "./staged-source-types.ts";

const normalizeParentCompressions = (
  parentCompressions: InputParentCompression[] | undefined,
): SharedParentCompression[] =>
  (parentCompressions || []).map((entry) => ({
    decompressionTimeMs: entry.decompressionTimeMs,
    depth: entry.depth,
    fileName: entry.fileName,
    kind: entry.kind,
    outputSize: entry.outputSize,
    sourceSize: entry.sourceSize,
  }));

const cloneParentCompressions = (parentCompressions: SharedParentCompression[] | undefined) =>
  (parentCompressions || []).map((entry) => ({ ...entry }));

const releasePreparedFile = (file?: InputAsset["file"]) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedFileAndWait = async (file?: InputAsset["file"]) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) await Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedRomSource = <TSource, TState extends SharedRomSourceState>(
  source?: SharedRomStagedSource<TSource, TState>,
) => {
  if (!source) return;
  for (const asset of source.preparedInputAssets || []) releasePreparedFile(asset.file);
  source.preparedInputAssets = undefined;
};

const releasePreparedRomSourceAndWait = async <TSource, TState extends SharedRomSourceState>(
  source?: SharedRomStagedSource<TSource, TState>,
) => {
  if (!source) return;
  await Promise.all((source.preparedInputAssets || []).map((asset) => releasePreparedFileAndWait(asset.file)));
  source.preparedInputAssets = undefined;
};

export {
  cloneParentCompressions,
  normalizeParentCompressions,
  releasePreparedRomSource,
  releasePreparedRomSourceAndWait,
};
