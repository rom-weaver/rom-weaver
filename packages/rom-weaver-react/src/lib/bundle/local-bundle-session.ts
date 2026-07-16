import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import { createCleanupOnce } from "../../storage/shared/disposal.ts";
import type { ParsedBundleSourceRef } from "../../types/bundle.ts";
import { fetchRemoteFiles } from "../remote/remote-file-fetch.ts";
import type { BundleApplySession, BundleApplySessionEntry } from "./bundle-session-model.ts";
import { bundleChainEndpointChecks, bundleRomExpectation, bundleSessionDisplayName } from "./bundle-session-model.ts";

const normalizePath = (value: string) =>
  value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");

const baseName = (value: string) => normalizePath(value).split("/").pop() || value;

const createBundleAbortError = () => {
  const error = new Error("Bundle loading was aborted");
  error.name = "AbortError";
  return error;
};

const resolveDroppedPath = (files: File[], requested: string, label: string): File => {
  const normalized = normalizePath(requested);
  const exact = files.filter((file) => normalizePath(file.webkitRelativePath || file.name) === normalized);
  if (exact.length === 1) return exact[0] as File;
  if (exact.length > 1) throw new Error(`Bundle ${label} path is ambiguous: ${requested}`);
  const basenameMatches = files.filter((file) => baseName(file.name) === baseName(normalized));
  if (basenameMatches.length === 1) return basenameMatches[0] as File;
  if (basenameMatches.length > 1) throw new Error(`Bundle ${label} basename is ambiguous: ${requested}`);
  throw new Error(`Bundle ${label} file is missing from this drop: ${requested}`);
};

const loadSource = async (
  source: ParsedBundleSourceRef,
  files: File[],
  extractedFiles: Map<string, File>,
  label: string,
  signal?: AbortSignal,
): Promise<{ cleanup?: () => Promise<void>; file: File }> => {
  if (signal?.aborted) throw createBundleAbortError();
  if (source.kind === "extracted") {
    const file = extractedFiles.get(source.extractedPath);
    if (!file) throw new Error(`Bundle ${label} was not extracted: ${source.extractedPath}`);
    return { file };
  }
  if (source.kind === "path") return { file: resolveDroppedPath(files, source.path, label) };
  try {
    const url = new URL(source.url);
    const [fetched] = await fetchRemoteFiles([{ url: url.toString() }], signal);
    if (!fetched) throw new Error(`Bundle ${label} download returned no file`);
    return { cleanup: fetched.cleanup, file: fetched.file };
  } catch (error) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(source.url)) {
      return { file: resolveDroppedPath(files, source.url, label) };
    }
    throw error;
  }
};

type LoadLocalBundleOptions = {
  /**
   * Content-probe mode: the caller only suspects `bundleFile` is a bundle (a
   * non-canonically-named `*.json`, or an archive whose index is not
   * `rom-weaver-bundle.json`). A PARSE failure then means "not a bundle" and
   * resolves to `null` so the caller falls back to normal routing. Acquisition
   * failures still throw - once the JSON parses+validates it IS a bundle, and a
   * missing member is a real, surfaceable error.
   */
  probe?: boolean;
  signal?: AbortSignal;
};

type LoadedLocalBundle = {
  cleanup: () => Promise<void>;
  patchFiles: File[];
  romFile: File | undefined;
  session: BundleApplySession;
};

// Authoritative load (canonical name): parse errors surface.
async function loadLocalBundleSession(
  bundleFile: File,
  droppedFiles: File[],
  options?: { probe?: false; signal?: AbortSignal },
): Promise<LoadedLocalBundle>;
// Probe load: a parse failure resolves to null so the caller can fall back.
async function loadLocalBundleSession(
  bundleFile: File,
  droppedFiles: File[],
  options: { probe: true; signal?: AbortSignal },
): Promise<LoadedLocalBundle | null>;
async function loadLocalBundleSession(
  bundleFile: File,
  droppedFiles: File[],
  { probe = false, signal }: LoadLocalBundleOptions = {},
): Promise<LoadedLocalBundle | null> {
  const parse = browserRuntime.bundle?.parse;
  if (!parse) throw new Error("Bundle parsing is not available in this runtime");
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse({ fileName: bundleFile.name, signal, source: bundleFile });
  } catch (error) {
    if (probe && !signal?.aborted) return null;
    throw error;
  }
  const { result, extractedFiles } = parsed;
  const acquiredCleanups: Array<() => Promise<void>> = [parsed.cleanup];
  const cleanup = createCleanupOnce(async () => {
    await Promise.all(acquiredCleanups.map((release) => release()));
  });
  const acquisitionController = new AbortController();
  const abortAcquisition = () => acquisitionController.abort();
  if (signal?.aborted) abortAcquisition();
  else signal?.addEventListener("abort", abortAcquisition, { once: true });
  let acquisitionFailed = false;
  let firstAcquisitionError: unknown;
  const acquire = <T>(promise: Promise<T>) =>
    promise.catch((error: unknown) => {
      if (!acquisitionFailed) {
        acquisitionFailed = true;
        firstAcquisitionError = error;
      }
      abortAcquisition();
      throw error;
    });
  try {
    const [settledRom, ...settledPatches] = await Promise.allSettled([
      result.romSource
        ? acquire(loadSource(result.romSource, droppedFiles, extractedFiles, "ROM", acquisitionController.signal))
        : Promise.resolve(undefined),
      ...result.patchSources.map((patch, index) =>
        acquire(
          loadSource(patch.source, droppedFiles, extractedFiles, `patch ${index + 1}`, acquisitionController.signal),
        ),
      ),
    ]);
    const acquiredSources = [settledRom, ...settledPatches].flatMap((entry) =>
      entry.status === "fulfilled" && entry.value ? [entry.value] : [],
    );
    for (const acquired of acquiredSources) {
      if (acquired.cleanup) acquiredCleanups.push(acquired.cleanup);
    }
    if (acquisitionFailed || signal?.aborted) {
      throw acquisitionFailed ? firstAcquisitionError : createBundleAbortError();
    }
    const romSource = settledRom.status === "fulfilled" ? settledRom.value : undefined;
    const acquiredPatches = settledPatches.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
    const romFile = romSource?.file;
    const patchFiles = acquiredPatches.map((entry) => entry.file);
    const entries: BundleApplySessionEntry[] = result.bundle.patches.map((patch, index) => {
      const file = patchFiles[index];
      if (!file) throw new Error(`Bundle patch ${index + 1} was not acquired`);
      return {
        acquisition: { extractedPath: file.name, kind: "extracted" },
        fileName: file.name,
        optional: patch.optional === true,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(patch.label ? { label: patch.label } : {}),
        ...(patch.header ? { header: patch.header } : {}),
        ...(patch.inputChecks ? { inputChecks: patch.inputChecks } : {}),
        ...(patch.outputChecks ? { outputChecks: patch.outputChecks } : {}),
      };
    });
    const output = result.bundle.output;
    const name = bundleSessionDisplayName(result.bundle);
    const romExpectation = romFile ? undefined : bundleRomExpectation(result.bundle);
    const session: BundleApplySession = {
      chainEndpointChecks: bundleChainEndpointChecks(result.bundle),
      entries,
      key: `local:${bundleFile.name}:${bundleFile.size}:${bundleFile.lastModified}`,
      ...(name ? { name } : {}),
      outputDefaults: {
        ...(output?.name ? { name: output.name } : {}),
        ...(output?.header ? { header: output.header } : {}),
      },
      ...(romFile ? { romFileName: romFile.name } : {}),
      ...(romExpectation ? { romExpectation } : {}),
      warnings: result.warnings,
    };
    return { cleanup, patchFiles, romFile, session };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortAcquisition);
  }
}

export { loadLocalBundleSession };
