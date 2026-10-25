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
// The Playlist tool's copies of handed-over discs; a reload or closed tab never disposes them.
const PLAYLIST_RETENTION_OPFS_PATH = "/work/runtime-output/playlist";
const logger = createLogger("browser-opfs-cleanup");
// A reload while work runs leaves the previous page's workers holding sync access handles for a moment, so
// removeEntry fails with NoModificationAllowedError. The proxy worker already retries; what is still locked
// then belongs to a dying page and the next boot sweeps it. Match the DOMException name (every engine);
// the text pattern is a fallback for stacks that carry only the Chromium-style "Name: message" prefix.
const BUSY_REMOVE_PATTERN = /NoModificationAllowedError|modifications are not allowed/i;
let bootCleanupPromise: Promise<void> | null = null;

const resetBrowserTransientOpfs = async (
  options: { includeEmulator?: boolean; skipBusy?: boolean } = {},
): Promise<void> => {
  const paths = options.includeEmulator
    ? [...TRANSIENT_OPFS_PATHS, EMULATOR_RETENTION_OPFS_PATH, PLAYLIST_RETENTION_OPFS_PATH]
    : TRANSIENT_OPFS_PATHS;
  await Promise.all(
    paths.map(async (filePath) => {
      const response = await requestBrowserOpfsStorage({ action: "remove", filePath });
      if (response.success) return;
      const message = response.error?.message || `Unable to remove OPFS path: ${filePath}`;
      const busy = response.error?.name === "NoModificationAllowedError" || BUSY_REMOVE_PATTERN.test(message);
      if (options.skipBusy && busy) {
        logger.debug("Skipped locked OPFS path during cleanup", { filePath });
        return;
      }
      throw new Error(message);
    }),
  );
};

// libarchive spools some writers (7z) into `libarchive_XXXXXX` files at the OPFS root. A run that dies
// before removing its temp file (tab closed or worker killed mid-compress) leaves it behind. Only the
// boot sweep, which holds the exclusive lock while no other page is alive, may remove them.
const LIBARCHIVE_TEMP_PREFIX = "libarchive_";
// Per-run TMPDIR directories made for compress runs (see rom-weaver-runner); the same boot-time rule applies.
const RUN_SCRATCH_DIR_PREFIX = "rw-tmp-";

const sweepStaleLibarchiveTemps = async (): Promise<void> => {
  const response = await requestBrowserOpfsStorage({ action: "list-metadata" });
  if (!response.success) return;
  const stale = (response.entries || []).filter(
    (entry) =>
      entry.path.lastIndexOf("/") === 0 &&
      ((entry.kind === "file" && entry.path.startsWith(`/${LIBARCHIVE_TEMP_PREFIX}`)) ||
        (entry.kind === "directory" && entry.path.startsWith(`/${RUN_SCRATCH_DIR_PREFIX}`))),
  );
  await Promise.all(
    stale.map(async (entry) => {
      const removed = await requestBrowserOpfsStorage({ action: "remove", filePath: `/work${entry.path}` });
      if (!removed.success) logger.debug("Skipped stale compress temp", { path: entry.path });
    }),
  );
};

const startBrowserOpfsBootCleanup = (): Promise<void> => {
  if (!bootCleanupPromise) {
    const cleanup = async () => {
      await resetBrowserTransientOpfs({ includeEmulator: true, skipBusy: true });
      await sweepStaleLibarchiveTemps();
    };
    const locks = globalThis.navigator?.locks;
    bootCleanupPromise = locks
      ? new Promise<void>((resolve, reject) => {
          // Pages MUST queue their shared lifetime lease before releasing the exclusive boot
          // lock, so another boot cannot delete outputs owned by any surviving page.
          const name = "rom-weaver-opfs-pages";
          void locks
            .request(name, { ifAvailable: true }, async (lock) => {
              if (lock) await cleanup();
              void locks
                .request(name, { mode: "shared" }, () => {
                  resolve();
                  return new Promise<void>(() => {
                    // The lease MUST remain held until the browser destroys this page.
                  });
                })
                .catch(reject);
            })
            .catch(reject);
        })
      : cleanup();
  }
  return bootCleanupPromise;
};

const waitForBrowserOpfsBootCleanup = () => bootCleanupPromise || Promise.resolve();

const listBrowserOpfs = async (): Promise<BrowserOpfsEntry[]> => {
  const response = await requestBrowserOpfsStorage({ action: "list" });
  if (!response.success) throw new Error(response.error?.message || "Unable to list OPFS paths");
  return response.entries || [];
};

export { listBrowserOpfs, resetBrowserTransientOpfs, startBrowserOpfsBootCleanup, waitForBrowserOpfsBootCleanup };
