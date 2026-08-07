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
const EMULATOR_RETENTION_OPFS_PATH = "/work/runtime-output/emulator";
let bootCleanupPromise: Promise<void> | null = null;

const resetBrowserTransientOpfs = async (options: { includeEmulator?: boolean } = {}): Promise<void> => {
  const paths = options.includeEmulator
    ? [...TRANSIENT_OPFS_PATHS, EMULATOR_RETENTION_OPFS_PATH]
    : TRANSIENT_OPFS_PATHS;
  await Promise.all(
    paths.map(async (filePath) => {
      const response = await requestBrowserOpfsStorage({ action: "remove", filePath });
      if (!response.success) throw new Error(response.error?.message || `Unable to remove OPFS path: ${filePath}`);
    }),
  );
};

const startBrowserOpfsBootCleanup = (): Promise<void> => {
  if (!bootCleanupPromise) bootCleanupPromise = resetBrowserTransientOpfs({ includeEmulator: true });
  return bootCleanupPromise;
};

const waitForBrowserOpfsBootCleanup = () => bootCleanupPromise || Promise.resolve();

const listBrowserOpfs = async (): Promise<BrowserOpfsEntry[]> => {
  const response = await requestBrowserOpfsStorage({ action: "list" });
  if (!response.success) throw new Error(response.error?.message || "Unable to list OPFS paths");
  return response.entries || [];
};

export { listBrowserOpfs, resetBrowserTransientOpfs, startBrowserOpfsBootCleanup, waitForBrowserOpfsBootCleanup };
