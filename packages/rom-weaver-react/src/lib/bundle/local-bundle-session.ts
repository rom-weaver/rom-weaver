import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
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
): Promise<File> => {
  if (source.kind === "extracted") {
    const file = extractedFiles.get(source.extractedPath);
    if (!file) throw new Error(`Bundle ${label} was not extracted: ${source.extractedPath}`);
    return file;
  }
  if (source.kind === "path") return resolveDroppedPath(files, source.path, label);
  try {
    const url = new URL(source.url);
    const [fetched] = await fetchRemoteFiles([{ url: url.toString() }]);
    if (!fetched) throw new Error(`Bundle ${label} download returned no file`);
    return fetched.file;
  } catch (error) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(source.url)) return resolveDroppedPath(files, source.url, label);
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
};

type LoadedLocalBundle = { patchFiles: File[]; romFile: File | undefined; session: BundleApplySession };

// Authoritative load (canonical name): parse errors surface.
async function loadLocalBundleSession(bundleFile: File, droppedFiles: File[]): Promise<LoadedLocalBundle>;
// Probe load: a parse failure resolves to null so the caller can fall back.
async function loadLocalBundleSession(
  bundleFile: File,
  droppedFiles: File[],
  options: { probe: true },
): Promise<LoadedLocalBundle | null>;
async function loadLocalBundleSession(
  bundleFile: File,
  droppedFiles: File[],
  { probe = false }: LoadLocalBundleOptions = {},
): Promise<LoadedLocalBundle | null> {
  const parse = browserRuntime.bundle?.parse;
  if (!parse) throw new Error("Bundle parsing is not available in this runtime");
  let parsed: Awaited<ReturnType<typeof parse>>;
  try {
    parsed = await parse({ fileName: bundleFile.name, source: bundleFile });
  } catch (error) {
    if (probe) return null;
    throw error;
  }
  const { result, extractedFiles } = parsed;
  const romFile = result.romSource
    ? await loadSource(result.romSource, droppedFiles, extractedFiles, "ROM")
    : undefined;
  const patchFiles = await Promise.all(
    result.patchSources.map((patch, index) =>
      loadSource(patch.source, droppedFiles, extractedFiles, `patch ${index + 1}`),
    ),
  );
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
  return { patchFiles, romFile, session };
}

export { loadLocalBundleSession };
