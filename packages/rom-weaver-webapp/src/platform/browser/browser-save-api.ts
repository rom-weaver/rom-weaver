import {
  invokeRomWeaverSaveIdentifyWorker,
  invokeRomWeaverSaveInspectWorker,
  invokeRomWeaverSaveSetWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { SaveEditorResult } from "../../lib/runtime/save-editor-result.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";

const { browserRuntime } = await import("./workflow-runtime.ts");

type BrowserSaveInput = {
  fileName?: string;
  game?: string;
  romSha1?: string;
  signal?: AbortSignal;
  source: BrowserSourceRef | Uint8Array;
};
type BrowserSaveSetInput = BrowserSaveInput & { assignments: string[]; outputName: string };

const saveSourceSize = (source: BrowserSourceRef | Uint8Array): number | undefined => {
  if (source instanceof Uint8Array) return source.byteLength;
  if (typeof Blob !== "undefined" && source instanceof Blob) return source.size;
  if (typeof source === "object" && "size" in source && typeof source.size === "number") return source.size;
  if (typeof source === "object" && "source" in source && source.source instanceof Blob) return source.source.size;
  return undefined;
};

const stageSaveInput = (input: BrowserSaveInput) => {
  const size = saveSourceSize(input.source);
  if (size !== undefined && size > 128 * 1024 * 1024) throw new Error("The save file is larger than 128 MiB.");
  return browserRuntime.workerIo.stageSource({
    fallbackFileName: input.fileName || "save.sav",
    pathPrefix: "save-editor-input",
    scope: "checksum",
    source: input.source,
  });
};

const runBrowserSaveRead = async (
  input: BrowserSaveInput,
  run: (filePath: string) => Promise<{ parsed: SaveEditorResult }>,
) => {
  const staged = await stageSaveInput(input);
  try {
    return (await run(staged.filePath)).parsed;
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

const identifySave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveIdentifyWorker({ inputPath, game: input.game, romSha1: input.romSha1, signal: input.signal }),
  );

const inspectSave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath) =>
    invokeRomWeaverSaveInspectWorker({ inputPath, game: input.game, romSha1: input.romSha1, signal: input.signal }),
  );

const setSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    const result = await invokeRomWeaverSaveSetWorker({
      assignments: input.assignments,
      game: input.game,
      inputPath: staged.filePath,
      outputName: input.outputName,
      romSha1: input.romSha1,
      signal: input.signal,
    });
    const workerResult = result as SaveEditorResult & {
      parsed: SaveEditorResult;
      filePath?: string;
      fileName?: string;
      size?: number;
      timing?: PublicOutput["timing"];
    };
    const output = await browserRuntime.workerIo.createWorkerOutput(
      workerResult,
      input.outputName,
      "Save editor did not return an edited save",
    );
    return { ...workerResult.parsed, output };
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

const previewSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    return await invokeRomWeaverSaveSetWorker({
      assignments: input.assignments,
      dryRun: true,
      game: input.game,
      inputPath: staged.filePath,
      outputName: input.outputName,
      romSha1: input.romSha1,
      signal: input.signal,
    });
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

export { identifySave, inspectSave, previewSaveFields, setSaveFields };
