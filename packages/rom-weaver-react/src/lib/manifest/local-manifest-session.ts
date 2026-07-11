import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import type { ParsedManifestSourceRef } from "../../types/manifest.ts";
import { fetchRemoteFiles } from "../remote/remote-file-fetch.ts";
import type { ManifestApplySession, ManifestApplySessionEntry } from "./manifest-session-model.ts";
import {
  manifestChainEndpointChecks,
  manifestRomExpectation,
  manifestSessionDisplayName,
} from "./manifest-session-model.ts";

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
  if (exact.length > 1) throw new Error(`Manifest ${label} path is ambiguous: ${requested}`);
  const basenameMatches = files.filter((file) => baseName(file.name) === baseName(normalized));
  if (basenameMatches.length === 1) return basenameMatches[0] as File;
  if (basenameMatches.length > 1) throw new Error(`Manifest ${label} basename is ambiguous: ${requested}`);
  throw new Error(`Manifest ${label} file is missing from this drop: ${requested}`);
};

const loadSource = async (
  source: ParsedManifestSourceRef,
  files: File[],
  extractedFiles: Map<string, File>,
  label: string,
): Promise<File> => {
  if (source.kind === "extracted") {
    const file = extractedFiles.get(source.extractedPath);
    if (!file) throw new Error(`Manifest ${label} was not extracted: ${source.extractedPath}`);
    return file;
  }
  if (source.kind === "path") return resolveDroppedPath(files, source.path, label);
  try {
    const url = new URL(source.url);
    const [fetched] = await fetchRemoteFiles([{ url: url.toString() }]);
    if (!fetched) throw new Error(`Manifest ${label} download returned no file`);
    return fetched.file;
  } catch (error) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(source.url)) return resolveDroppedPath(files, source.url, label);
    throw error;
  }
};

const loadLocalManifestSession = async (manifestFile: File, droppedFiles: File[]) => {
  const parse = browserRuntime.manifest?.parse;
  if (!parse) throw new Error("Manifest parsing is not available in this runtime");
  const { result, extractedFiles } = await parse({ fileName: manifestFile.name, source: manifestFile });
  const romFile = result.romSource
    ? await loadSource(result.romSource, droppedFiles, extractedFiles, "ROM")
    : undefined;
  const patchFiles = await Promise.all(
    result.patchSources.map((patch, index) =>
      loadSource(patch.source, droppedFiles, extractedFiles, `patch ${index + 1}`),
    ),
  );
  const entries: ManifestApplySessionEntry[] = result.manifest.patches.map((patch, index) => {
    const file = patchFiles[index];
    if (!file) throw new Error(`Manifest patch ${index + 1} was not acquired`);
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
  const output = result.manifest.output;
  const name = manifestSessionDisplayName(result.manifest);
  const romExpectation = romFile ? undefined : manifestRomExpectation(result.manifest);
  const session: ManifestApplySession = {
    chainEndpointChecks: manifestChainEndpointChecks(result.manifest),
    entries,
    key: `local:${manifestFile.name}:${manifestFile.size}:${manifestFile.lastModified}`,
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
};

export { loadLocalManifestSession };
