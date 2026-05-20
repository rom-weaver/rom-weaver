import { RomWeaverError } from "../../lib/errors.ts";

type PublicSourceValidationOptions = {
  environmentLabel: string;
};

const isUnsupportedByteSource = (source: unknown) => source instanceof ArrayBuffer || ArrayBuffer.isView(source);

const isBlob = (source: unknown) => typeof Blob !== "undefined" && source instanceof Blob;
const isFileSystemFileHandleLike = (source: unknown) =>
  !!(
    source &&
    typeof source === "object" &&
    (source as { kind?: unknown }).kind === "file" &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  );
const isSourceWrapper = (source: unknown): source is { data?: unknown; source?: unknown } =>
  !!source && typeof source === "object" && ("data" in source || "source" in source);
const isVfsFileRef = (source: unknown) =>
  !!source && typeof source === "object" && "vfs" in source && typeof (source as { path?: unknown }).path === "string";

const getReceivedType = (source: unknown) => source?.constructor?.name || typeof source;

const createPublicSourceValidator =
  ({ environmentLabel }: PublicSourceValidationOptions) =>
  (source: unknown) => {
    if (isUnsupportedByteSource(source))
      throw new RomWeaverError("SOURCE_UNSUPPORTED", `Raw byte sources are not public ${environmentLabel} inputs`, {
        details: { received: getReceivedType(source) },
      });
    if (isSourceWrapper(source) && isUnsupportedByteSource(source.source ?? source.data))
      throw new RomWeaverError(
        "SOURCE_UNSUPPORTED",
        `Raw byte source wrappers are not public ${environmentLabel} inputs`,
        {
          details: { received: getReceivedType(source.source ?? source.data) },
        },
      );
    if (
      source &&
      typeof source === "object" &&
      !isBlob(source) &&
      !isFileSystemFileHandleLike(source) &&
      !isVfsFileRef(source) &&
      !isSourceWrapper(source)
    )
      throw new RomWeaverError(
        "INVALID_INPUT",
        `${environmentLabel} public sources must be strings, Blob values, file handles, or source wrappers`,
        {
          details: { received: source.constructor.name },
        },
      );
  };

const createPublicSourcesValidator =
  <TSource>(assertPublicSource: (source: unknown) => void) =>
  (sources: TSource | TSource[] | undefined) => {
    const sourceList = Array.isArray(sources) ? sources : [];
    if (sources && !Array.isArray(sources)) sourceList.push(sources);
    for (const source of sourceList) assertPublicSource(source);
  };

export { createPublicSourcesValidator, createPublicSourceValidator };
