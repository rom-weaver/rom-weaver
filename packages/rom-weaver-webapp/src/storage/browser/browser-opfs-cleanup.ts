import { cleanupBrowserOpfsRunScratch } from "../../wasm/browser-opfs-run-cleanup.ts";
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
// then belongs to a dying page and the next boot sweeps it. Match the DOMException name (every engine);
// the text pattern is a fallback for stacks that carry only the Chromium-style "Name: message" prefix.
const BUSY_REMOVE_PATTERN = /NoModificationAllowedError|modifications are not allowed/i;
// Marks a failed boot sweep, which only leaves stale scratch behind, apart from a failure to take the lifetime lease.
class BootSweepFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BootSweepFailure";
  }
}
let bootSweepFailureLogged = false;
let bootCleanupPromise: Promise<void> | null = null;
// In-flight user-requested reset sweeps; commands wait for them like they wait for the boot sweep.
const pendingResetSweeps = new Set<Promise<void>>();
const ownedTransientOpfsPaths = new Set<string>();
const ownedRunScratchIds = new Set<string>();

const registerBrowserOpfsRunScratch = (runId: string): (() => void) => {
  ownedRunScratchIds.add(runId);
  return () => {
    ownedRunScratchIds.delete(runId);
  };
};

// Callers MUST register only their own unique scratch directory, before writing into it.
const registerBrowserTransientOpfsPath = (filePath: string): (() => void) => {
  ownedTransientOpfsPaths.add(filePath);
  return () => {
    ownedTransientOpfsPaths.delete(filePath);
  };
};

const removeTransientOpfs = async (paths: readonly string[], options: { skipBusy?: boolean } = {}): Promise<void> => {
  // Every removal MUST settle before this reports a failure, so work that proceeds after a failed sweep cannot
  // race a removal that is still deleting the same directory.
  const results = await Promise.allSettled(
    paths.map(async (filePath) => {
      const response = await requestBrowserOpfsStorage({ action: "remove", filePath });
      if (response.success) {
        ownedTransientOpfsPaths.delete(filePath);
        return;
      }
      const message = response.error?.message || `Unable to remove OPFS path: ${filePath}`;
      const busy = response.error?.name === "NoModificationAllowedError" || BUSY_REMOVE_PATTERN.test(message);
      if (options.skipBusy && busy) {
        logger.debug("Skipped locked OPFS path during cleanup", { filePath });
        return;
      }
      throw new Error(message);
    }),
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
};

const resetBrowserTransientOpfs = (options: { skipBusy?: boolean } = {}): Promise<void> => {
  const paths = [...ownedTransientOpfsPaths];
  const runIds = [...ownedRunScratchIds];
  const sweep = (async () => {
    const results = await Promise.allSettled([
      removeTransientOpfs(paths, options),
      ...runIds.map(async (runId) => {
        await cleanupBrowserOpfsRunScratch({ runId, workGuestPath: "/work" });
        ownedRunScratchIds.delete(runId);
      }),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  })();
  pendingResetSweeps.add(sweep);
  const settled = () => {
    pendingResetSweeps.delete(sweep);
  };
  sweep.then(settled, settled);
  return sweep;
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
      await removeTransientOpfs([...TRANSIENT_OPFS_PATHS, EMULATOR_RETENTION_OPFS_PATH], { skipBusy: true });
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
              // A failed sweep must still take the shared lease below, or a later tab would win the
              // exclusive lock and delete scratch this page is using. The error still rejects the promise.
              let sweepError: unknown;
              let sweepFailed = false;
              if (lock) {
                await cleanup().catch((error: unknown) => {
                  sweepFailed = true;
                  sweepError = error;
                });
              }
              void locks
                .request(name, { mode: "shared" }, () => {
                  if (sweepFailed) reject(new BootSweepFailure(sweepError));
                  else resolve();
                  return new Promise<void>(() => {
                    // The lease MUST remain held until the browser destroys this page.
                  });
                })
                .catch(reject);
            })
            .catch(reject);
        })
      : cleanup().catch((error: unknown) => {
          throw new BootSweepFailure(error);
        });
  }
  return bootCleanupPromise;
};

// Starts the boot sweep when no caller has yet, then waits for it and any in-flight reset sweep. A failed sweep
// only leaves stale scratch behind, so it is logged and work proceeds; a reset sweep's own failure is reported
// to whoever started it. The boot caller of `startBrowserOpfsBootCleanup` still sees the rejection.
const waitForBrowserOpfsBootCleanup = async (): Promise<void> => {
  const resets = [...pendingResetSweeps].map((sweep) => sweep.catch(() => undefined));
  await Promise.all(resets);
  await startBrowserOpfsBootCleanup().catch((error: unknown) => {
    // A failed lease request still rejects: without the lifetime lease another tab could sweep live scratch.
    if (!(error instanceof BootSweepFailure)) throw error;
    if (bootSweepFailureLogged) return;
    bootSweepFailureLogged = true;
    logger.warn("Boot OPFS cleanup failed; continuing without it", { message: error.message });
  });
};

const listBrowserOpfs = async (): Promise<BrowserOpfsEntry[]> => {
  const response = await requestBrowserOpfsStorage({ action: "list" });
  if (!response.success) throw new Error(response.error?.message || "Unable to list OPFS paths");
  return response.entries || [];
};

export {
  listBrowserOpfs,
  registerBrowserOpfsRunScratch,
  registerBrowserTransientOpfsPath,
  resetBrowserTransientOpfs,
  startBrowserOpfsBootCleanup,
  waitForBrowserOpfsBootCleanup,
};
