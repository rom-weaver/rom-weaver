import { requestBrowserOpfsStorage } from "../workers/protocol/browser-opfs-worker-client.ts";
import { joinGuestPath } from "./browser-opfs-guest-paths.ts";

type ListedOpfsEntry = {
  kind: "directory" | "file";
  path: string;
};

const EXTRACT_STAGING_PREFIX = ".rom-weaver-extract-";
const TEMP_NAMESPACE_PREFIX = "rw-";

const entryName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const getFileDescendantPaths = (entries: readonly ListedOpfsEntry[]) => {
  const descendants = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    let separator = entry.path.lastIndexOf("/");
    while (separator > 0) {
      descendants.add(entry.path.slice(0, separator));
      separator = entry.path.lastIndexOf("/", separator - 1);
    }
  }
  return descendants;
};

const findRunTempNamespacePaths = (entries: readonly ListedOpfsEntry[], runId: string): string[] => {
  const namespace = `${TEMP_NAMESPACE_PREFIX}${runId}`;
  const prefix = `${namespace}-`;
  return entries
    .filter((entry) => {
      if (entry.kind !== "directory") return false;
      const name = entryName(entry.path);
      return name === namespace || name.startsWith(prefix);
    })
    .map((entry) => entry.path);
};

const findEmptyExtractStagingPaths = (entries: readonly ListedOpfsEntry[], runId: string): string[] => {
  const prefix = `${EXTRACT_STAGING_PREFIX}${runId}-`;
  const fileDescendantPaths = getFileDescendantPaths(entries);
  return entries
    .filter(
      (entry) =>
        entry.kind === "directory" && entryName(entry.path).startsWith(prefix) && !fileDescendantPaths.has(entry.path),
    )
    .map((entry) => entry.path);
};

const removeOpfsPath = async (path: string): Promise<void> => {
  const response = await requestBrowserOpfsStorage({
    action: "remove",
    filePath: path,
  });
  if (!response.success) throw new Error(response.error?.message || `Unable to remove OPFS path: ${path}`);
};

export const cleanupBrowserOpfsRunScratch = async ({
  runId,
  trace,
  workGuestPath,
}: {
  runId: string;
  trace?: (message: string) => void;
  workGuestPath: string;
}): Promise<void> => {
  const listResponse = await requestBrowserOpfsStorage({ action: "list-metadata" });
  if (!listResponse.success) throw new Error(listResponse.error?.message || "Unable to list OPFS scratch paths");

  const entries = (listResponse.entries || []) as ListedOpfsEntry[];
  const tempNamespacePaths = findRunTempNamespacePaths(entries, runId);
  const emptyExtractPaths = findEmptyExtractStagingPaths(entries, runId);
  // Keep extract trees containing files. A failed extract may have staged user data, so cleanup
  // removes only the empty transaction directories it can prove are disposable.
  const paths = [...tempNamespacePaths, ...emptyExtractPaths].map((path) => joinGuestPath(workGuestPath, path));
  await Promise.all(
    paths.map(async (path) => {
      await removeOpfsPath(path);
      trace?.(`[browser-opfs] removed run scratch path=${path}`);
    }),
  );
};

export { findEmptyExtractStagingPaths, findRunTempNamespacePaths };
