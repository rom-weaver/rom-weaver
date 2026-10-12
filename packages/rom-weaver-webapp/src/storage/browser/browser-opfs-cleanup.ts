import { createLogger } from "../../lib/logging.ts";
import { requestBrowserOpfsStorage, type BrowserOpfsEntry } from "../../workers/protocol/browser-opfs-worker-client.ts";

// These are application scratch buckets. Host-ingested files live under rom-weaver-imports and are
// deliberately preserved across reload/reset because they are user-owned input, not transient state.
const TRANSIENT_OPFS_PATHS = [
  "/work/weave-parse",
  "/work/bundle-parse",
  "/work/input",
  "/work/operations",
  "/work/output",
  "/work/patches",
  "/work/rom-weaver-out",
  "/work/temp",
] as const;
const EMULATOR_RETENTION_OPFS_PATH = "/work/runtime-output/emulator";
const logger = createLogger("browser-opfs-cleanup");
// A reload while work runs leaves the previous page's workers holding sync access handles for a moment, so
// removeEntry fails with NoModificationAllowedError. The proxy worker already retries; what is still locked
// then belongs to a dying page and the next boot sweeps it.
const BUSY_REMOVE_PATTERN = /NoModificationAllowedError|modifications are not allowed/i;
let bootCleanupPromise: Promise<void> | null = null;

const resetBrowserTransientOpfs = async (
  options: { includeEmulator?: boolean; skipBusy?: boolean } = {},
): Promise<void> => {
  const paths = options.includeEmulator
    ? [...TRANSIENT_OPFS_PATHS, EMULATOR_RETENTION_OPFS_PATH]
    : TRANSIENT_OPFS_PATHS;
  await Promise.all(
    paths.map(async (filePath) => {
      const response = await requestBrowserOpfsStorage({ action: "remove", filePath });
      if (response.success) return;
      const message = response.error?.message || `Unable to remove OPFS path: ${filePath}`;
      if (options.skipBusy && BUSY_REMOVE_PATTERN.test(message)) {
        logger.debug("Skipped locked OPFS path during cleanup", { filePath });
        return;
      }
      throw new Error(message);
    }),
  );
};

const startBrowserOpfsBootCleanup = (): Promise<void> => {
  if (!bootCleanupPromise) bootCleanupPromise = resetBrowserTransientOpfs({ includeEmulator: true, skipBusy: true });
  return bootCleanupPromise;
};

const waitForBrowserOpfsBootCleanup = () => bootCleanupPromise || Promise.resolve();

const listBrowserOpfs = async (): Promise<BrowserOpfsEntry[]> => {
  const response = await requestBrowserOpfsStorage({ action: "list" });
  if (!response.success) throw new Error(response.error?.message || "Unable to list OPFS paths");
  return response.entries || [];
};

export { listBrowserOpfs, resetBrowserTransientOpfs, startBrowserOpfsBootCleanup, waitForBrowserOpfsBootCleanup };
