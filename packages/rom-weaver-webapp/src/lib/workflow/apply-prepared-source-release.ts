import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { getPatchFileCleanup } from "../input/binary-service.ts";
import type { StagedSource } from "./apply-workflow-state.ts";

const releasePreparedFile = (file?: PatchFileInstance) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) void Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedSource = (source?: StagedSource<unknown>) => {
  if (!source) return;
  for (const asset of source.preparedInputAssets || []) releasePreparedFile(asset.file);
  releasePreparedFile(source.preparedPatchFile);
  source.preparedInputAssets = undefined;
  source.preparedPatchFile = undefined;
  source.parsedPatch = undefined;
  source.state.requirements = undefined;
  source.state.checksumPreflight = undefined;
  source.state.patchValidation = undefined;
};

const releasePreparedFileAndWait = async (file?: PatchFileInstance) => {
  const cleanup = file ? getPatchFileCleanup(file) : undefined;
  if (cleanup) await Promise.resolve(cleanup()).catch(() => undefined);
};

const releasePreparedSourceAndWait = async (source?: StagedSource<unknown>) => {
  if (!source) return;
  await Promise.all((source.preparedInputAssets || []).map((asset) => releasePreparedFileAndWait(asset.file)));
  await releasePreparedFileAndWait(source.preparedPatchFile);
  source.preparedInputAssets = undefined;
  source.preparedPatchFile = undefined;
  source.parsedPatch = undefined;
  source.state.requirements = undefined;
  source.state.checksumPreflight = undefined;
  source.state.patchValidation = undefined;
};

export { releasePreparedSource, releasePreparedSourceAndWait };
