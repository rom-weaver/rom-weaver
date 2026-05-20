import type { PatchedOutputPlan } from "./patched-output-plan.ts";

type OutputPlan = PatchedOutputPlan;

type OutputRuntimePayload = {
  patchedAsset: { _u8array?: Uint8Array; file?: Blob | File } | Uint8Array | ArrayBuffer;
  outputPlan: OutputPlan;
};

type SavedOutputValue =
  | string
  | Blob
  | Uint8Array
  | ArrayBuffer
  | object
  | {
      file?: Blob | File;
      fileName?: string | null;
      _u8array?: Uint8Array;
    }
  | null
  | undefined;

type OutputRuntime = {
  saveArchive?: (
    payload: OutputRuntimePayload,
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
  saveChd?: (
    payload: OutputRuntimePayload,
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
  saveRvz?: (
    payload: OutputRuntimePayload,
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
  saveZ3ds?: (
    payload: OutputRuntimePayload,
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
  saveRaw?: (
    payload: OutputRuntimePayload,
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
  saveCueOutput?: (
    payload: OutputRuntimePayload & { cueOutput: { fileName: string; text: string } },
  ) => SavedOutputValue | SavedOutputValue[] | Promise<SavedOutputValue | SavedOutputValue[]>;
};

const toSavedFileList = (value: SavedOutputValue | SavedOutputValue[] | null | undefined): SavedOutputValue[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return [value].filter(Boolean);
};

const executePatchedOutput = async ({
  patchedAsset,
  outputPlan,
  runtime,
}: {
  patchedAsset: OutputRuntimePayload["patchedAsset"];
  outputPlan: OutputPlan;
  runtime?: OutputRuntime | null;
}) => {
  const outputRuntime = runtime || {};

  if (outputPlan.kind === "7z" || outputPlan.kind === "zip") {
    return toSavedFileList(await outputRuntime.saveArchive?.({ outputPlan, patchedAsset }));
  }
  if (outputPlan.kind === "chd") {
    return toSavedFileList(await outputRuntime.saveChd?.({ outputPlan, patchedAsset }));
  }
  if (outputPlan.kind === "rvz") {
    return toSavedFileList(await outputRuntime.saveRvz?.({ outputPlan, patchedAsset }));
  }
  if (outputPlan.kind === "z3ds") {
    return toSavedFileList(await outputRuntime.saveZ3ds?.({ outputPlan, patchedAsset }));
  }

  const savedFiles = toSavedFileList(await outputRuntime.saveRaw?.({ outputPlan, patchedAsset }));
  if (!outputPlan.cueOutput) return savedFiles;

  const cueFiles = toSavedFileList(
    await outputRuntime.saveCueOutput?.({ cueOutput: outputPlan.cueOutput, outputPlan, patchedAsset }),
  );
  return savedFiles.concat(cueFiles);
};

export type { OutputRuntime, OutputRuntimePayload, SavedOutputValue };
export { executePatchedOutput };
