import { requestBrowserOpfsStorage, type BrowserOpfsEntry } from "../../workers/protocol/browser-opfs-worker-client.ts";

// These are application scratch buckets. Host-ingested files live under rom-weaver-imports and are
// deliberately preserved across reload/reset because they are user-owned input, not transient state.
const TRANSIENT_OPFS_PATHS = [
  "/work/bundle-parse",
  "/work/input",
  "/work/operations",
  "/work/output",
  "/work/patches",
  "/work/rom-weaver-out",
  "/work/temp",
] as const;

const resetBrowserTransientOpfs = async (): Promise<void> => {
  await Promise.all(
    TRANSIENT_OPFS_PATHS.map(async (filePath) => {
      const response = await requestBrowserOpfsStorage({ action: "remove", filePath });
      if (!response.success) throw new Error(response.error?.message || `Unable to remove OPFS path: ${filePath}`);
    }),
  );
};

const listBrowserOpfs = async (): Promise<BrowserOpfsEntry[]> => {
  const response = await requestBrowserOpfsStorage({ action: "list" });
  if (!response.success) throw new Error(response.error?.message || "Unable to list OPFS paths");
  return response.entries || [];
};

export { listBrowserOpfs, resetBrowserTransientOpfs };
