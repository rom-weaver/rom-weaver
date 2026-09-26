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
  schema?: File | null;
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

const stageSaveSchema = (schema?: File | null) => {
  if (!schema) return undefined;
  if (schema.size > 2 * 1024 * 1024) throw new Error("The save schema pack is larger than 2 MiB.");
  return browserRuntime.workerIo.stageSource({
    fallbackFileName: schema.name || "save-schema.json",
    pathPrefix: "save-schema",
    scope: "checksum",
    source: schema,
  });
};

const withSaveSchema = async <T>(schema: File | null | undefined, run: (schemaPath?: string) => Promise<T>) => {
  const staged = await stageSaveSchema(schema);
  try {
    return await run(staged?.filePath);
  } finally {
    await staged?.cleanup().catch(() => undefined);
  }
};

const runBrowserSaveRead = async (
  input: BrowserSaveInput,
  run: (filePath: string, schemaPath?: string) => Promise<{ parsed: SaveEditorResult }>,
) => {
  const staged = await stageSaveInput(input);
  try {
    return await withSaveSchema(input.schema, async (schemaPath) => (await run(staged.filePath, schemaPath)).parsed);
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

const identifySave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath, schemaPath) =>
    invokeRomWeaverSaveIdentifyWorker({
      inputPath,
      game: input.game,
      romSha1: input.romSha1,
      schemaPath,
      signal: input.signal,
    }),
  );

const inspectSave = (input: BrowserSaveInput) =>
  runBrowserSaveRead(input, (inputPath, schemaPath) =>
    invokeRomWeaverSaveInspectWorker({
      inputPath,
      game: input.game,
      romSha1: input.romSha1,
      schemaPath,
      signal: input.signal,
    }),
  );

const listSaveGames = async (signal?: AbortSignal, schema?: File | null) =>
  withSaveSchema(
    schema,
    async (schemaPath) => (await invokeRomWeaverSaveListGamesWorker({ schemaPath, signal })).parsed,
  );

const createSave = async (input: { game: string; schema?: File | null; signal?: AbortSignal }) => {
  const outputName = `${input.game}.sav`;
  const result = await withSaveSchema(input.schema, (schemaPath) =>
    invokeRomWeaverSaveCreateWorker({
      assignments: [],
      game: input.game,
      outputName,
      schemaPath,
      signal: input.signal,
    }),
  );
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
    return await withSaveSchema(input.schema, async (schemaPath) => {
      const run = input.create ? invokeRomWeaverSaveCreateWorker : invokeRomWeaverSaveSetWorker;
      const result = await run({
        assignments: input.assignments,
        game: input.game,
        inputPath: staged.filePath,
        outputName: input.outputName,
        romSha1: input.romSha1,
        schemaPath,
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
    });
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

const previewSaveFields = async (input: BrowserSaveSetInput) => {
  const staged = await stageSaveInput(input);
  try {
    return await withSaveSchema(input.schema, (schemaPath) =>
      invokeRomWeaverSaveSetWorker({
        assignments: input.assignments,
        dryRun: true,
        game: input.game,
        inputPath: staged.filePath,
        outputName: input.outputName,
        romSha1: input.romSha1,
        schemaPath,
        signal: input.signal,
      }),
    );
  } finally {
    await staged.cleanup().catch(() => undefined);
  }
};

export { createSave, listSaveGames, identifySave, inspectSave, previewSaveFields, setSaveFields };
