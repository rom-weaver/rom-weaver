// The `?manifest=` boot flow's I/O half: fetch the rw.json (plain, compressed, or archive), parse it
// through the wasm runtime, build the session plan, then acquire every non-disabled source - URL
// entries via the shared remote fetch layer, bundled entries from the parse call's materialized
// Files. Returns the ordered drop-pipeline Files (ROM first, patches in manifest order) plus the
// decorated session the apply form consumes. Kept out of the React hook so tests drive the same code.

import { createLogger } from "../../lib/logging.ts";
import type { ManifestApplySession, ManifestApplySessionEntry } from "../../lib/manifest/manifest-session-model.ts";
import { buildManifestApplySessionPlan } from "../../lib/manifest/manifest-session-model.ts";
import type { RemoteFetchEntry } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles } from "../../lib/remote/remote-file-fetch.ts";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";

const logger = createLogger("manifest-url-session");

type ManifestUrlSessionProgress = { loadedBytes: number; totalBytes: number | null };

type LoadManifestUrlSessionHooks = {
  /** Fires once the manifest itself is parsed, before its sources download. */
  onManifestName?: (name: string) => void;
  /** Per-download progress; `id` is stable per fetched source within one load. */
  onProgress?: (id: string, progress: ManifestUrlSessionProgress) => void;
  signal?: AbortSignal;
};

type LoadedManifestUrlSession = {
  /** Drop-pipeline delivery order: ROM first (when present), then patches in manifest order. */
  files: File[];
  session: ManifestApplySession;
};

const loadManifestUrlSession = async (
  manifestUrl: string,
  hooks: LoadManifestUrlSessionHooks = {},
): Promise<LoadedManifestUrlSession> => {
  const { onManifestName, onProgress, signal } = hooks;
  logger.info(`loading manifest session: ${manifestUrl}`);
  const [manifestFetch] = await fetchRemoteFiles(
    [
      {
        fallbackFileName: "rw.json",
        onProgress: (progress) => onProgress?.("manifest", progress),
        url: manifestUrl,
      },
    ],
    signal,
  );
  if (!manifestFetch) throw new Error(`Manifest download returned no file: ${manifestUrl}`);
  const parse = browserRuntime.manifest?.parse;
  if (!parse) throw new Error("Manifest parsing is not available in this runtime");
  const { result, extractedFiles } = await parse({
    fileName: manifestFetch.file.name,
    signal,
    source: manifestFetch.file,
  });
  const plan = buildManifestApplySessionPlan(result, manifestFetch.finalUrl || manifestUrl);
  onManifestName?.(plan.name || "");
  for (const warning of plan.warnings) logger.warn(`manifest warning: ${warning}`);

  const materializeExtracted = (extractedPath: string, label: string): File => {
    const file = extractedFiles.get(extractedPath);
    if (!file) throw new Error(`Manifest ${label} was not extracted: ${extractedPath}`);
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
    const fetched = await fetchRemoteFiles(fetchEntries, signal);
    fetched.forEach((entry, index) => {
      fetchSlots[index]?.assign(entry.file);
    });
  }

  const acquiredPatchFiles: File[] = [];
  const entries: ManifestApplySessionEntry[] = plan.entries.map((entry, index) => {
    const file = patchFiles[index];
    if (!file) throw new Error(`Manifest patch ${index + 1} was not acquired`);
    acquiredPatchFiles.push(file);
    return { ...entry, fileName: file.name };
  });
  const acquiredRomFile: File | null = romFile;
  const session: ManifestApplySession = {
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
  logger.info(`manifest session loaded (${files.length} file(s), ${entries.length} patch(es))`);
  return { files, session };
};

export { loadManifestUrlSession };
