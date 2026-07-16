import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import { joinVfsPath } from "../../storage/vfs/path.ts";
import { createVfsPathId } from "../../storage/vfs/path-id.ts";
import { removeManagedOpfsPath } from "../../workers/protocol/opfs-path.ts";
import { getFileNameParts, getPathBaseName, joinPath } from "../path-utils.ts";

const WORK_ROOT_PATH = "/work";
const OPERATION_ROOT_NAME = "operations";

const normalizeAbsolutePosixPath = (pathValue: string): string => {
  const normalized = String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalized.startsWith("/")) return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
};

type RomWeaverOutputScope = {
  cleanup: () => Promise<void>;
  createOutputCleanups: (
    outputPaths: readonly string[],
    removeOutputPath: (filePath: string) => Promise<void>,
  ) => Promise<Array<() => Promise<void>>>;
  rootPath: string;
  selectOutputPath: (sourcePath: string, outputFileName: string, blockedPaths?: Array<string | undefined>) => string;
};

const createRomWeaverOutputScope = (): RomWeaverOutputScope => {
  const rootPath = joinVfsPath(WORK_ROOT_PATH, OPERATION_ROOT_NAME, createVfsPathId());
  const cleanup = createCleanupOnce(() => removeManagedOpfsPath(rootPath));
  const createOutputCleanups: RomWeaverOutputScope["createOutputCleanups"] = async (outputPaths, removeOutputPath) => {
    if (!outputPaths.length) {
      await cleanup();
      return [];
    }
    let remainingOutputs = outputPaths.length;
    const remainingPathReferences = new Map<string, number>();
    for (const filePath of outputPaths) {
      remainingPathReferences.set(filePath, (remainingPathReferences.get(filePath) || 0) + 1);
    }
    return outputPaths.map((filePath) =>
      createCleanupOnce(async () => {
        const remainingPathReferencesCount = (remainingPathReferences.get(filePath) || 1) - 1;
        if (remainingPathReferencesCount) remainingPathReferences.set(filePath, remainingPathReferencesCount);
        else remainingPathReferences.delete(filePath);
        try {
          if (!remainingPathReferencesCount) await removeOutputPath(filePath);
        } finally {
          remainingOutputs -= 1;
          if (!remainingOutputs) await cleanup();
        }
      }),
    );
  };
  const selectOutputPath: RomWeaverOutputScope["selectOutputPath"] = (
    sourcePath,
    outputFileName,
    // `modifiedFilePath` is optional now that patch-create accepts cheat codes
    // instead of a modified ROM; undefined entries are coerced/filtered below.
    blockedPaths = [],
  ) => {
    const outputBaseName = getPathBaseName(outputFileName, "output.bin");
    const preferredPath = joinPath(rootPath, outputBaseName);
    const normalizedPreferredPath = normalizeAbsolutePosixPath(preferredPath);
    const normalizedBlocked = new Set(
      [sourcePath, ...blockedPaths]
        .map((pathValue) => normalizeAbsolutePosixPath(pathValue ?? ""))
        .filter((pathValue) => !!pathValue),
    );
    if (normalizedBlocked.has(normalizedPreferredPath)) {
      throw new Error(`Browser output path conflicts with an active input or patch: ${preferredPath}`);
    }
    return preferredPath;
  };
  return { cleanup, createOutputCleanups, rootPath, selectOutputPath };
};

const runWithRomWeaverOutputScope = async <TResult extends object>(
  sourcePath: string,
  outputFileName: string,
  blockedPaths: Array<string | undefined>,
  run: (outputPath: string) => Promise<TResult>,
): Promise<TResult & { cleanup: () => Promise<void> }> => {
  const scope = createRomWeaverOutputScope();
  try {
    const result = await run(scope.selectOutputPath(sourcePath, outputFileName, blockedPaths));
    const resultCleanup = (result as { cleanup?: () => Promise<void> | void }).cleanup;
    return {
      ...result,
      cleanup: createCleanupOnce(async () => {
        try {
          await Promise.resolve(resultCleanup?.());
        } finally {
          await scope.cleanup();
        }
      }),
    };
  } catch (error) {
    await scope.cleanup().catch(() => undefined);
    throw error;
  }
};

const appendTrimmedOutputMarker = (fileName: string) => {
  const { extension, stem } = getFileNameParts(fileName || "trimmed.bin");
  const normalizedStem = stem.trim() || "trimmed";
  const trimmedStem = /\(trimmed\)$/i.test(normalizedStem) ? normalizedStem : `${normalizedStem} (trimmed)`;
  return `${trimmedStem}${extension || ".bin"}`;
};

const getTrimOutputFileName = (sourceFilePath: string, requestedOutputName: string | undefined) => {
  const sourceBaseName = getPathBaseName(sourceFilePath, "trimmed.bin");
  const requestedBaseName = getPathBaseName(requestedOutputName || sourceBaseName, sourceBaseName);
  const sourceParts = getFileNameParts(sourceBaseName);
  const requestedParts = getFileNameParts(requestedBaseName);
  if (requestedParts.stem.trim().toLowerCase() === sourceParts.stem.trim().toLowerCase()) {
    return appendTrimmedOutputMarker(requestedBaseName);
  }
  return requestedBaseName;
};

export { createRomWeaverOutputScope, getTrimOutputFileName, runWithRomWeaverOutputScope };
