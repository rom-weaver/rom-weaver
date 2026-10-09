// The `?weave=` boot flow's I/O half: fetch the rom-weaver-weave.json (plain, compressed, or archive), parse it
// through the wasm runtime, build the session plan, then acquire every non-disabled source - URL
// entries via the shared remote fetch layer, bundled entries from the parse call's materialized
// Files. Returns the ordered drop-pipeline Files (ROM first, patches in weave order) plus the
// decorated session the apply form consumes. Kept out of the React hook so tests drive the same code.

import type { WeaveApplySession, WeaveApplySessionEntry } from "../../lib/weave/weave-session-model.ts";
import { buildWeaveApplySessionPlan } from "../../lib/weave/weave-session-model.ts";
import { createLogger } from "../../lib/logging.ts";
import type { RemoteFetchEntry } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles } from "../../lib/remote/remote-file-fetch.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";

const logger = createLogger("weave-url-session");

type WeaveUrlSessionProgress = { loadedBytes: number; totalBytes: number | null };

type LoadWeaveUrlSessionHooks = {
  /** Fires once the weave itself is parsed, before its sources download. */
  onWeaveName?: (name: string) => void;
  /** Per-download progress; `id` is stable per fetched source within one load. */
  onProgress?: (id: string, progress: WeaveUrlSessionProgress) => void;
  signal?: AbortSignal;
};

type LoadedWeaveUrlSession = {
  cleanup: () => Promise<void>;
  /** Drop-pipeline delivery order: ROM first (when present), then patches in weave order. */
  files: File[];
  session: WeaveApplySession;
};

const acquireWeaveFiles = async (
  plan: ReturnType<typeof buildWeaveApplySessionPlan>,
  extractedFiles: Map<string, File>,
  onProgress: LoadWeaveUrlSessionHooks["onProgress"],
  signal?: AbortSignal,
) => {
  const materializeExtracted = (extractedPath: string, label: string): File => {
    const file = extractedFiles.get(extractedPath);
    if (!file) throw new Error(`Weave ${label} was not extracted: ${extractedPath}`);
    return file;
  };
  const fetchEntries: RemoteFetchEntry[] = [];
  const fetchSlots: Array<{ assign: (file: File) => void }> = [];
  let romFile: File | null = null;
  if (plan.romAcquisition?.kind === "extracted") {
    romFile = materializeExtracted(plan.romAcquisition.extractedPath, "ROM");
  } else if (plan.romAcquisition) {
    fetchEntries.push({
      onProgress: (progress) => onProgress?.("rom", progress),
      url: plan.romAcquisition.url,
    });
    fetchSlots.push({ assign: (file) => (romFile = file) });
  }
  const patchFiles: Array<File | null> = plan.entries.map((entry, index) => {
    if (entry.acquisition.kind === "extracted")
      return materializeExtracted(entry.acquisition.extractedPath, `patch ${index + 1}`);
    fetchEntries.push({
      onProgress: (progress) => onProgress?.(`patch-${index}`, progress),
      url: entry.acquisition.url,
    });
    fetchSlots.push({ assign: (file) => (patchFiles[index] = file) });
    return null;
  });
  const remoteSourceFetches = fetchEntries.length ? await fetchRemoteFiles(fetchEntries, signal) : [];
  remoteSourceFetches.forEach((entry, index) => {
    fetchSlots[index]?.assign(entry.file);
  });
  const acquiredPatchFiles: File[] = [];
  const entries: WeaveApplySessionEntry[] = plan.entries.map((entry, index) => {
    const file = patchFiles[index];
    if (!file) throw new Error(`Weave patch ${index + 1} was not acquired`);
    acquiredPatchFiles.push(file);
    return { ...entry, fileName: file.name };
  });
  return { acquiredPatchFiles, entries, remoteSourceFetches, romFile };
};

const loadWeaveUrlSession = async (
  weaveUrl: string,
  hooks: LoadWeaveUrlSessionHooks = {},
): Promise<LoadedWeaveUrlSession> => {
  const { onWeaveName, onProgress, signal } = hooks;
  logger.info(`loading weave session: ${weaveUrl}`);
  const [weaveFetch] = await fetchRemoteFiles(
    [
      {
        fallbackFileName: "rom-weaver-weave.json",
        onProgress: (progress) => onProgress?.("weave", progress),
        url: weaveUrl,
      },
    ],
    signal,
  );
  if (!weaveFetch) throw new Error(`Weave download returned no file: ${weaveUrl}`);
  const { browserRuntime } = await import("../../platform/browser/workflow-runtime.ts");
  const parse = browserRuntime.weave?.parse;
  if (!parse) {
    await weaveFetch.cleanup();
    throw new Error("Weave parsing is not available in this runtime");
  }
  const parsed = await (async () => {
    try {
      return await parse({
        fileName: weaveFetch.file.name,
        signal,
        source: weaveFetch.file,
      });
    } finally {
      await weaveFetch.cleanup();
    }
  })();
  const { result, extractedFiles } = parsed;
  let remoteSourceFetches: Awaited<ReturnType<typeof fetchRemoteFiles>> = [];
  const cleanup = createCleanupOnce(async () => {
    await Promise.all([parsed.cleanup(), ...remoteSourceFetches.map((entry) => entry.cleanup())]);
  });

  try {
    const plan = buildWeaveApplySessionPlan(result, weaveFetch.finalUrl || weaveUrl);
    onWeaveName?.(plan.name || "");
    for (const warning of plan.warnings) logger.warn(`weave warning: ${warning}`);
    const acquisition = await acquireWeaveFiles(plan, extractedFiles, onProgress, signal);
    remoteSourceFetches = acquisition.remoteSourceFetches;
    const { acquiredPatchFiles, entries } = acquisition;
    const acquiredRomFile = acquisition.romFile;
    const session: WeaveApplySession = {
      chainEndpointChecks: plan.chainEndpointChecks,
      entries,
      key: plan.key,
      patchBasis: plan.patchBasis,
      ...(plan.romMember ? { romMember: plan.romMember } : {}),
      ...(plan.name ? { name: plan.name } : {}),
      outputDefaults: plan.outputDefaults,
      ...(acquiredRomFile ? { romFileName: acquiredRomFile.name } : {}),
      ...(!acquiredRomFile && plan.romExpectation ? { romExpectation: plan.romExpectation } : {}),
      warnings: plan.warnings,
    };
    const files = [...(acquiredRomFile ? [acquiredRomFile] : []), ...acquiredPatchFiles];
    logger.info(`weave session loaded (${files.length} file(s), ${entries.length} patch(es))`);
    return { cleanup, files, session };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export { loadWeaveUrlSession };
