import { getFileNameExtension as getSharedFileNameExtension, stripFileNameQuery } from "../../../lib/path-utils.ts";
import { getBaseName, isRecord } from "./source-shared.ts";

type SourceValue = RuntimeValue;

type SourceFileNameOptions = {
  allowString?: boolean;
  fallback?: string;
  keys?: string[];
};

type SourceExtensionOptions = {
  stripQuery?: boolean;
};

type SourceFileNameGetter = (source: SourceValue) => string;

type NamedSourceOptions = {
  fallback?: string;
  nameKeys?: string[];
  sourceKeys?: string[];
};

type SourceReadablePatchFileLike = {
  fileName?: string;
  getExtension?: () => string;
};

const getNestedSource = (source: SourceValue, sourceKeys?: string[]): SourceValue => {
  if (!isRecord(source)) return source;
  const keys = Array.isArray(sourceKeys) && sourceKeys.length ? sourceKeys : ["data", "source"];
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value !== "function") return value;
  }
  return source;
};

const getSourceFileName = (source: SourceValue, options?: SourceFileNameOptions): string => {
  options = options || {};
  if (!source) return options.fallback || "";
  if (options.allowString && typeof source === "string") return source;

  const keys = Array.isArray(options.keys) ? options.keys : [];
  const record = isRecord(source) ? source : null;
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") return value;
  }

  return options.fallback || "";
};

const getNamedSource = (source: SourceValue, options?: NamedSourceOptions): SourceValue =>
  getNestedSource(source, options?.sourceKeys);

const getFiniteSourceSize = (source: SourceValue): number | null => {
  if (!isRecord(source)) return null;
  if (typeof source.size === "number" && Number.isFinite(source.size)) return source.size;
  if (typeof source.fileSize === "number" && Number.isFinite(source.fileSize)) return source.fileSize;
  return null;
};

const getNamedSourceSize = (source: SourceValue): number | null => {
  const sourceSize = getFiniteSourceSize(source);
  if (sourceSize !== null) return sourceSize;
  const directSource = getNamedSource(source);
  return getFiniteSourceSize(directSource);
};

const getNamedSourcePath = (source: SourceValue): string => {
  const directSource = getNamedSource(source);
  if (typeof directSource === "string" && directSource.trim()) return directSource;
  if (isRecord(directSource) && typeof directSource.path === "string" && directSource.path.trim())
    return directSource.path;
  if (isRecord(directSource) && typeof directSource.filePath === "string" && directSource.filePath.trim())
    return directSource.filePath;
  if (isRecord(source) && typeof source.filePath === "string" && source.filePath.trim()) return source.filePath;
  if (isRecord(source) && typeof source.path === "string" && source.path.trim()) return source.path;
  return "";
};

const getRecordFileName = (source: RuntimeValue, keys: string[]): string | undefined => {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const getNamedSourceFileName = (source: SourceValue, options?: NamedSourceOptions): string => {
  const fallback = options?.fallback || "";
  const nameKeys =
    Array.isArray(options?.nameKeys) && options.nameKeys.length ? options.nameKeys : ["fileName", "name"];
  const sourceFileName = getRecordFileName(source, nameKeys);
  if (sourceFileName) return sourceFileName;

  const directSource = getNamedSource(source, options);
  if (typeof directSource === "string") {
    return getBaseName(directSource) || fallback;
  }
  if (isRecord(directSource)) {
    const directFileName = getSourceFileName(directSource, {
      fallback,
      keys: ["fileName", "name"],
    });
    if (directFileName) return directFileName.trim();
  }

  return fallback;
};

const getSourceExtension = (
  source: SourceValue,
  getFileName?: SourceFileNameGetter,
  options?: SourceExtensionOptions,
): string => {
  if (isRecord(source)) {
    const getExtension = (source as SourceReadablePatchFileLike).getExtension;
    if (typeof getExtension === "function") return String((getExtension as () => string).call(source)).toLowerCase();
  }

  const rawFileName = String(typeof getFileName === "function" ? getFileName(source) : source || "").toLowerCase();
  const fileName = options?.stripQuery === true ? stripFileNameQuery(rawFileName) : rawFileName;
  return getSharedFileNameExtension(fileName, { stripQuery: false });
};

export {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourcePath,
  getNamedSourceSize,
  getSourceExtension,
  getSourceFileName,
};
