import OutputCompressionManager from "../lib/compression/output-compression-manager.ts";
import {
  isArchiveCompressionFormat,
  type RomSpecificCompressionFormat,
} from "../lib/compression/container-format-registry.ts";
import { toPublicOutput } from "../lib/apply/patch-apply-service.ts";
import { createBlobBackedPatchFile, getPatchFileCleanup } from "../lib/input/binary-service.ts";
import { parseCueFileReferences } from "../lib/input/archive.ts";
import type { InputAsset } from "../lib/input/input-assets.ts";
import { buildSessionOutputFiles, createSingleFileRomSpecificOutput } from "../lib/output/output-build-service.ts";
import { createArchiveOutput } from "../lib/output/archive-output-service.ts";
import { getFileNameWithoutExtension } from "../lib/input/path-utils.ts";
import { getChdAutoCreateMode } from "../lib/input/rom-specific-file-utils.ts";
import { isLikelyDiscImageSize } from "../lib/compression/disc-image-policy.ts";
import { ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS } from "../lib/compression/rom-specific-format-support.ts";
import type { WorkflowRuntime } from "../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../types/workflow-runtime-types.ts";

type ConcreteCompressFormat = "zip" | "7z" | RomSpecificCompressionFormat;

type CompressSource = {
  fileName: string;
  size: number;
  metadata?: Record<string, unknown>;
};

type ValidatedCompressInput = {
  cue?: File;
  files: File[];
  cueProblem?: string;
  source: CompressSource;
};

const ARCHIVE_FORMATS = ["zip", "7z"] as const;
const ROM_SPECIFIC_FORMATS = ["chd", "rvz", "z3ds"] as const;
const getExtension = (fileName: string) => fileName.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() || "";

const assertFiles = (files: File[]) => {
  if (files.length === 0) throw new Error("Select at least one file to compress");
  const names = new Set<string>();
  for (const file of files) {
    if (!file.name) throw new Error("Every compression input must have a file name");
    if (names.has(file.name)) throw new Error(`Duplicate archive entry path: ${file.name}`);
    names.add(file.name);
  }
};

const validateInputs = async (files: File[]): Promise<ValidatedCompressInput> => {
  assertFiles(files);
  const cueFiles = files.filter((file) => getExtension(file.name) === "cue");
  if (cueFiles.length === 0) {
    return {
      files,
      source: {
        fileName: files[0]?.name || "input.bin",
        size: files[0]?.size || 0,
        ...(/\.(bin|iso)$/i.test(files[0]?.name || "")
          ? {
              metadata: { mode: getChdAutoCreateMode({ fileName: files[0]?.name, size: files[0]?.size }) },
            }
          : {}),
      },
    };
  }
  if (cueFiles.length !== 1) {
    return {
      files,
      cueProblem: "Compress accepts one CUE disc group at a time",
      source: { fileName: files[0]?.name || "input.bin", size: files[0]?.size || 0 },
    };
  }
  const cue = cueFiles[0];
  if (!cue) throw new Error("CUE input is unavailable");
  const references = parseCueFileReferences(await cue.text()).map((reference) => reference.fileName);
  let cueProblem: string | undefined;
  if (references.length === 0) cueProblem = `CUE file has no referenced tracks: ${cue.name}`;
  const referenced = new Set(references);
  if (!cueProblem && referenced.size !== references.length) cueProblem = `CUE file repeats a track path: ${cue.name}`;
  const suppliedTracks = files.filter((file) => file !== cue);
  const suppliedNames = new Set(suppliedTracks.map((file) => file.name));
  const missing = references.filter((name) => !suppliedNames.has(name));
  if (!cueProblem && missing.length > 0) cueProblem = `CUE file references missing track: ${missing[0]}`;
  const extra = suppliedTracks.find((file) => !referenced.has(file.name));
  if (!cueProblem && extra) cueProblem = `CUE disc group contains an unreferenced file: ${extra.name}`;
  return {
    cue,
    cueProblem,
    files,
    source: {
      fileName: cue.name,
      size: cue.size,
      metadata: { cuePath: cue.name, format: "CD", mode: "cd" },
    },
  };
};

const getCompressSource = async (files: File[]): Promise<CompressSource | null> => {
  if (files.length === 0) return null;
  return (await validateInputs(files)).source;
};

const getCompressFormats = async (files: File[]): Promise<ConcreteCompressFormat[]> => {
  if (files.length === 0) return [];
  const input = await validateInputs(files);
  if (input.cue) return input.cueProblem ? [...ARCHIVE_FORMATS] : [...ARCHIVE_FORMATS, "chd"];
  if (input.files.length !== 1) return [...ARCHIVE_FORMATS];

  const source = { ...input.source, metadata: { ...input.source.metadata } };
  const extension = getExtension(source.fileName);
  if (extension === "gdi" || ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS.includes(extension))
    return [...ARCHIVE_FORMATS];
  return [
    ...ARCHIVE_FORMATS,
    ...ROM_SPECIFIC_FORMATS.filter(
      (format) =>
        OutputCompressionManager.supportsOutputCompression(source, format) &&
        (format !== "chd" || (source.size > 0 && isLikelyDiscImageSize(source.size))),
    ),
  ];
};

const createAssets = async (input: ValidatedCompressInput): Promise<InputAsset[]> => {
  const cueText = input.cue ? await input.cue.text() : undefined;
  return Promise.all(
    input.files.map(async (source, index) => {
      const file = await createBlobBackedPatchFile(source, source.name, undefined, null, { materialize: false });
      const isCue = source === input.cue;
      if (isCue) file.metadata = { ...file.metadata, cueText };
      else if (!input.cue) file.metadata = { ...file.metadata, ...input.source.metadata };
      let kind: InputAsset["kind"] = "rom";
      if (input.cue) kind = isCue ? "cue" : "track";
      return {
        file,
        fileName: source.name,
        groupId: input.cue ? "compress-cue-group" : undefined,
        id: `compress-${index}`,
        kind,
        patchable: !isCue,
        size: source.size,
      } satisfies InputAsset;
    }),
  );
};

const compressFiles = async (
  files: File[],
  options: ApplyWorkflowOptions,
  runtime: WorkflowRuntime,
): Promise<PublicOutput> => {
  assertFiles(files);
  if (options.signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
  const compression = options.output?.compression;
  if (typeof compression !== "string" || !compression || compression === "auto" || compression === "none") {
    throw new Error("Compress requires a concrete output format");
  }
  if (isArchiveCompressionFormat(compression)) {
    const baseName = options.output?.outputName?.trim() || getFileNameWithoutExtension(files[0]?.name || "archive");
    return createArchiveOutput({
      compression,
      entries: files.map((file) => ({ file, filename: file.name })),
      options,
      outputName: `${baseName}.${compression}`,
      runtime,
    });
  }
  const input = await validateInputs(files);
  if (compression === "chd" && input.cueProblem) throw new Error(input.cueProblem);
  const supported = await getCompressFormats(files);
  if (!supported.includes(compression as ConcreteCompressFormat)) {
    throw new Error(`Compression format ${compression} does not support this file set`);
  }

  const assets = await createAssets(input);
  let outputFile: Awaited<ReturnType<typeof buildSessionOutputFiles>>["files"][number] | undefined;
  try {
    if (assets.length === 1 && assets[0]) {
      outputFile =
        (await createSingleFileRomSpecificOutput({
          compression: compression as RomSpecificCompressionFormat,
          outputFile: assets[0].file,
          options,
          runtime,
        })) || undefined;
    } else {
      const result = await buildSessionOutputFiles(assets, new Map(), options, runtime);
      outputFile = result.files[0];
    }
    if (!outputFile) throw new Error("Compression did not produce an output file");
    const output = await toPublicOutput(outputFile, runtime);
    return output;
  } catch (error) {
    await Promise.resolve(outputFile ? getPatchFileCleanup(outputFile)?.() : undefined).catch(() => undefined);
    throw error;
  }
};

export type { CompressSource };
export { compressFiles, getCompressFormats, getCompressSource };
