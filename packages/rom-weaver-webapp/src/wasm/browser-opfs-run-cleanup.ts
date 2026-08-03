import { requestBrowserOpfsStorage } from "../workers/protocol/browser-opfs-worker-client.ts";
import { joinGuestPath } from "./browser-opfs-guest-paths.ts";

type ListedOpfsEntry = {
  kind: "directory" | "file";
  path: string;
};

const EXTRACT_STAGING_PREFIX = ".rom-weaver-extract-";

const entryName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const hasFileDescendant = (entries: readonly ListedOpfsEntry[], path: string) => {
  const prefix = `${path}/`;
  return entries.some((entry) => entry.kind === "file" && entry.path.startsWith(prefix));
};

const findEmptyExtractStagingPaths = (entries: readonly ListedOpfsEntry[], runId: string): string[] => {
  const prefix = `${EXTRACT_STAGING_PREFIX}${runId}-`;
  return entries
    .filter(
      (entry) =>
        entry.kind === "directory" &&
        entryName(entry.path).startsWith(prefix) &&
        !hasFileDescendant(entries, entry.path),
    )
    .map((entry) => entry.path)
    .sort((left, right) => right.length - left.length);
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
  const tempNamespacePath = joinGuestPath(workGuestPath, "rom-weaver-out", `rw-${runId}`);
  const listResponse = await requestBrowserOpfsStorage({ action: "list" });
  if (!listResponse.success) throw new Error(listResponse.error?.message || "Unable to list OPFS scratch paths");

  const entries = (listResponse.entries || []) as ListedOpfsEntry[];
  const emptyExtractPaths = findEmptyExtractStagingPaths(entries, runId);
  const paths = [tempNamespacePath, ...emptyExtractPaths.map((path) => joinGuestPath(workGuestPath, path))];
  await Promise.all(
    paths.map(async (path) => {
      await removeOpfsPath(path);
      trace?.(`[browser-opfs] removed run scratch path=${path}`);
    }),
  );
};

export { findEmptyExtractStagingPaths };
