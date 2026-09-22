import {
  invokeRomWeaverSaveIdentifyWorker,
  invokeRomWeaverSaveCreateWorker,
  invokeRomWeaverSaveListGamesWorker,
  invokeRomWeaverSaveInspectWorker,
  invokeRomWeaverSaveSetWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import type { SaveEditorResult } from "../../lib/runtime/save-editor-result.ts";
import type { BrowserSourceRef } from "../../types/source.ts";
import type { PublicOutput } from "../../types/workflow-runtime-types.ts";
import { readRuntimeOutputBlob } from "../../storage/vfs/runtime-output.ts";

const { browserRuntime } = await import("./workflow-runtime.ts");

type BrowserSaveInput = {
  fileName?: string;
  game?: string;
  romSha1?: string;
  signal?: AbortSignal;
  source: BrowserSourceRef | Uint8Array;
};
type BrowserSaveSetInput = BrowserSaveInput & { assignments: string[]; outputName: string; create?: boolean };

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

const listSaveGames = async (signal?: AbortSignal) => (await invokeRomWeaverSaveListGamesWorker({ signal })).parsed;

const createSave = async (input: { game: string; signal?: AbortSignal }) => {
  const outputName = `${input.game}.sav`;
  const result = await invokeRomWeaverSaveCreateWorker({
    ...input,
    assignments: [],
    outputName,
  });
  const output = await browserRuntime.workerIo.createWorkerOutput(
    result as typeof result & { filePath: string },
    outputName,
    "Save generation did not return a save",
  );
  try {
    return new File([await readRuntimeOutputBlob(output)], outputName, { type: "application/octet-stream" });
  } finally {
    await output.dispose();
  }
};

const setSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    const run = input.create ? invokeRomWeaverSaveCreateWorker : invokeRomWeaverSaveSetWorker;
    const result = await run({
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

export { createSave, listSaveGames, identifySave, inspectSave, previewSaveFields, setSaveFields };
