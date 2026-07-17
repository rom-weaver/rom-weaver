// The `?bundle=` boot flow's I/O half: fetch the rom-weaver-bundle.json (plain, compressed, or archive), parse it
// through the wasm runtime, build the session plan, then acquire every non-disabled source - URL
// entries via the shared remote fetch layer, bundled entries from the parse call's materialized
// Files. Returns the ordered drop-pipeline Files (ROM first, patches in bundle order) plus the
// decorated session the apply form consumes. Kept out of the React hook so tests drive the same code.

import type { BundleApplySession, BundleApplySessionEntry } from "../../lib/bundle/bundle-session-model.ts";
import { buildBundleApplySessionPlan } from "../../lib/bundle/bundle-session-model.ts";
import { createLogger } from "../../lib/logging.ts";
import type { RemoteFetchEntry } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles } from "../../lib/remote/remote-file-fetch.ts";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";

const logger = createLogger("bundle-url-session");

type BundleUrlSessionProgress = { loadedBytes: number; totalBytes: number | null };

type LoadBundleUrlSessionHooks = {
  /** Fires once the bundle itself is parsed, before its sources download. */
  onBundleName?: (name: string) => void;
  /** Per-download progress; `id` is stable per fetched source within one load. */
  onProgress?: (id: string, progress: BundleUrlSessionProgress) => void;
  signal?: AbortSignal;
};

type LoadedBundleUrlSession = {
  cleanup: () => Promise<void>;
  /** Drop-pipeline delivery order: ROM first (when present), then patches in bundle order. */
  files: File[];
  session: BundleApplySession;
};

const loadBundleUrlSession = async (
  bundleUrl: string,
  hooks: LoadBundleUrlSessionHooks = {},
): Promise<LoadedBundleUrlSession> => {
  const { onBundleName, onProgress, signal } = hooks;
  logger.info(`loading bundle session: ${bundleUrl}`);
  const [bundleFetch] = await fetchRemoteFiles(
    [
      {
        fallbackFileName: "rom-weaver-bundle.json",
        onProgress: (progress) => onProgress?.("bundle", progress),
        url: bundleUrl,
      },
    ],
    signal,
  );
  if (!bundleFetch) throw new Error(`Bundle download returned no file: ${bundleUrl}`);
  const parse = browserRuntime.bundle?.parse;
  if (!parse) {
    await bundleFetch.cleanup();
    throw new Error("Bundle parsing is not available in this runtime");
  }
  const parsed = await (async () => {
    try {
      return await parse({
        fileName: bundleFetch.file.name,
        signal,
        source: bundleFetch.file,
      });
    } finally {
      await bundleFetch.cleanup();
    }
  })();
  const { result, extractedFiles } = parsed;
  let remoteSourceFetches: Awaited<ReturnType<typeof fetchRemoteFiles>> = [];
  const cleanup = createCleanupOnce(async () => {
    await Promise.all([parsed.cleanup(), ...remoteSourceFetches.map((entry) => entry.cleanup())]);
  });

  try {
    const plan = buildBundleApplySessionPlan(result, bundleFetch.finalUrl || bundleUrl);
    onBundleName?.(plan.name || "");
    for (const warning of plan.warnings) logger.warn(`bundle warning: ${warning}`);

    const materializeExtracted = (extractedPath: string, label: string): File => {
      const file = extractedFiles.get(extractedPath);
      if (!file) throw new Error(`Bundle ${label} was not extracted: ${extractedPath}`);
      return file;
    };
    // One concurrent fetch pass over every URL source (ROM + patches); extracted sources are already
    // materialized. Slots keep the acquired Files index-aligned with the plan.
    const fetchEntries: RemoteFetchEntry[] = [];
    const fetchSlots: Array<{ assign: (file: File) => void }> = [];
    let romFile: File | null = null;
    if (plan.romAcquisition) {
      if (plan.romAcquisition.kind === "extracted") {
        romFile = materializeExtracted(plan.romAcquisition.extractedPath, "ROM");
      } else {
        fetchEntries.push({
          onProgress: (progress) => onProgress?.("rom", progress),
          url: plan.romAcquisition.url,
        });
        fetchSlots.push({
          assign: (file) => {
            romFile = file;
          },
        });
      }
    }
    const patchFiles: Array<File | null> = plan.entries.map((entry, index) => {
      if (entry.acquisition.kind === "extracted") {
        return materializeExtracted(entry.acquisition.extractedPath, `patch ${index + 1}`);
      }
      fetchEntries.push({
        onProgress: (progress) => onProgress?.(`patch-${index}`, progress),
        url: entry.acquisition.url,
      });
      fetchSlots.push({
        assign: (file) => {
          patchFiles[index] = file;
        },
      });
      return null;
    });
    if (fetchEntries.length) {
      remoteSourceFetches = await fetchRemoteFiles(fetchEntries, signal);
      remoteSourceFetches.forEach((entry, index) => {
        fetchSlots[index]?.assign(entry.file);
      });
    }

    const acquiredPatchFiles: File[] = [];
    const entries: BundleApplySessionEntry[] = plan.entries.map((entry, index) => {
      const file = patchFiles[index];
      if (!file) throw new Error(`Bundle patch ${index + 1} was not acquired`);
      acquiredPatchFiles.push(file);
      return { ...entry, fileName: file.name };
    });
    const acquiredRomFile: File | null = romFile;
    const session: BundleApplySession = {
      chainEndpointChecks: plan.chainEndpointChecks,
      entries,
      key: plan.key,
      ...(plan.name ? { name: plan.name } : {}),
      outputDefaults: plan.outputDefaults,
      ...(acquiredRomFile ? { romFileName: acquiredRomFile.name } : {}),
      ...(!acquiredRomFile && plan.romExpectation ? { romExpectation: plan.romExpectation } : {}),
      warnings: plan.warnings,
    };
    const files = [...(acquiredRomFile ? [acquiredRomFile] : []), ...acquiredPatchFiles];
    logger.info(`bundle session loaded (${files.length} file(s), ${entries.length} patch(es))`);
    return { cleanup, files, session };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export { loadBundleUrlSession };
