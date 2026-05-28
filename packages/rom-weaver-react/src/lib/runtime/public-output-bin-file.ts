import { readRuntimeOutputBlob, readRuntimeOutputBytes } from "../../storage/vfs/runtime-output.ts";
import { createVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { PublicOutput } from "../../types/workflow-runtime.ts";
import type { PatchFileInstance } from "../../workers/protocol/patch-engine.ts";
import { attachPatchFileSourceRef, createLazyExternalPatchFile, createPatchFile } from "../input/binary-service.ts";

type CreatePatchFileFromPublicOutputOptions = {
  materializeBlob?: boolean;
  preferExternalFilePath?: boolean;
};

type DirectReadablePublicOutput = PublicOutput & {
  blob?: Blob | null;
  bytes?: ArrayBufferLike | Uint8Array | null;
  data?: ArrayBufferLike | Uint8Array | null;
  file?: Blob | null;
};

const getDirectPublicOutputBlob = (output: PublicOutput): Blob | null => {
  const directOutput = output as DirectReadablePublicOutput;
  const blob = directOutput.file || directOutput.blob;
  return typeof Blob !== "undefined" && blob instanceof Blob ? blob : null;
};

const getDirectPublicOutputBytes = (output: PublicOutput): ArrayBufferLike | Uint8Array | null => {
  const directOutput = output as DirectReadablePublicOutput;
  const bytes = directOutput.bytes || directOutput.data;
  if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) return bytes;
  if (typeof SharedArrayBuffer === "function" && bytes instanceof SharedArrayBuffer) return bytes;
  return null;
};

const createPatchFileFromPublicOutput = async (
  output: PublicOutput,
  fallbackFileName: string,
  options: CreatePatchFileFromPublicOutputOptions = {},
): Promise<PatchFileInstance> => {
  const fileName = output.fileName || fallbackFileName;
  const outputSize = output.size;
  const canUseExternalFilePath = !!(
    output &&
    typeof output.path === "string" &&
    output.path &&
    output.vfs &&
    typeof output.vfs === "object" &&
    typeof output.vfs.normalizePath === "function"
  );
  const sourceRef = canUseExternalFilePath
    ? {
        fileName,
        size: outputSize,
        source: createVfsFileRef(output.vfs, output.path, {
          fileName,
          mediaType: output.mediaType,
        }),
      }
    : null;
  const attachChecksums = <TFile extends PatchFileInstance>(file: TFile): TFile => {
    if (output.checksums) (file as TFile & { checksums?: Record<string, string> }).checksums = output.checksums;
    return file;
  };
  if (canUseExternalFilePath && (options.materializeBlob === false || options.preferExternalFilePath === true)) {
    return attachChecksums(
      attachPatchFileSourceRef(
        createLazyExternalPatchFile(fileName, {
          cleanup: output.cleanup,
          filePath: output.path,
          fileType: output.mediaType,
          size: outputSize,
        }),
        sourceRef,
      ),
    );
  }
  const file = canUseExternalFilePath
    ? await createPatchFile(
        {
          data: await readRuntimeOutputBytes(output),
          fileName,
        },
        fileName,
      )
    : await (async () => {
        const directBlob = getDirectPublicOutputBlob(output);
        if (directBlob) return createPatchFile({ fileName, source: directBlob }, fileName);
        const directBytes = getDirectPublicOutputBytes(output);
        if (directBytes) return createPatchFile({ data: directBytes, fileName }, fileName);
        throw new Error("Public output is not readable: expected a VFS path, Blob, or byte source");
      })();
  if (canUseExternalFilePath) {
    (file as { filePath?: string }).filePath = output.path;
    (file as { _file?: Blob })._file = await readRuntimeOutputBlob(output);
  }
  return attachChecksums(attachPatchFileSourceRef(file, sourceRef));
};

export { createPatchFileFromPublicOutput };
