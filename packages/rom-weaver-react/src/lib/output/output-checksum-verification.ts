import type { ChecksumResult } from "../../types/checksum.ts";
import type { JsonValue } from "../../types/runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

const HEX_PREFIX_REGEX = /^0x/;
const HEX_DIGITS_REGEX = /^[0-9a-f]+$/i;
const DECIMAL_DIGITS_REGEX = /^\d+$/;

const SUPPORTED_OUTPUT_CHECKSUM_TYPES = ["CRC32", "MD5", "SHA1", "ADLER32"] as const;

type OutputChecksumType = (typeof SUPPORTED_OUTPUT_CHECKSUM_TYPES)[number];

type OutputChecksumInfo = {
  type: OutputChecksumType;
  expectedValues: string[];
  rawInfo: Record<string, JsonValue | object | undefined>;
};

type PatchValidationInfoLike = {
  type?: JsonValue | object;
  targetValue?: JsonValue;
  targetChecksumScope?: JsonValue;
  targetValueScope?: JsonValue;
};

type PatchedAssetLike = {
  _file?: Blob;
  _u8array?: Uint8Array;
  filePath?: string;
  fileSize?: number;
  size?: number;
  readBytesAt?: (offset: number, length: number) => Uint8Array | Promise<Uint8Array>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type PatchWithValidationInfo = {
  isXdeltaPatch?: boolean;
  getValidationInfo?: () => PatchValidationInfoLike | null | undefined;
};

type VerifyPatchedOutputOptions = {
  patchedAsset: PatchedAssetLike | ArrayBuffer | ArrayBufferView | Blob | Uint8Array;
  patch?: PatchWithValidationInfo | null;
  patches?: PatchWithValidationInfo[] | PatchWithValidationInfo | null;
  onProgress?: (loaded: number, total: number) => void;
  chunkSize?: number;
  runtime?: Pick<WorkflowRuntime, "checksum">;
  calculateChecksums?: (input: {
    source: VerifyPatchedOutputOptions["patchedAsset"];
    algorithms: string[];
  }) => Promise<ChecksumResult>;
};

type OutputChecksumResult = {
  available: boolean;
  matched: boolean;
  type: OutputChecksumType | "";
  expectedValues: string[];
  actualValue: string | null;
  message: string;
  info?: Record<string, JsonValue | object | undefined>;
};

const isRecord = (
  value: JsonValue | object | null | undefined,
): value is Record<string, JsonValue | object | undefined> =>
  !!value && (typeof value === "object" || typeof value === "function");

const normalizeChecksumType = (type: JsonValue | object | undefined): OutputChecksumType | "" => {
  const normalized = String(type || "")
    .trim()
    .toUpperCase()
    .replace(/[-_]/g, "");
  if (normalized === "SHA") return "SHA1";
  if (normalized === "ADLER") return "ADLER32";
  return SUPPORTED_OUTPUT_CHECKSUM_TYPES.includes(normalized as OutputChecksumType)
    ? (normalized as OutputChecksumType)
    : "";
};

const isNumericChecksumType = (type: OutputChecksumType): boolean => type === "CRC32" || type === "ADLER32";

const toUint32Hex = (value: JsonValue | undefined): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase().replace(HEX_PREFIX_REGEX, "");
  if (!raw) return null;
  if (HEX_DIGITS_REGEX.test(raw) && raw.length <= 8) return parseInt(raw, 16).toString(16).padStart(8, "0");
  if (DECIMAL_DIGITS_REGEX.test(raw)) return (parseInt(raw, 10) >>> 0).toString(16).padStart(8, "0");
  return null;
};

const normalizeChecksumValue = (type: JsonValue | object | undefined, value: JsonValue | undefined): string | null => {
  const normalizedType = normalizeChecksumType(type);
  if (!normalizedType) return null;
  if (isNumericChecksumType(normalizedType)) return toUint32Hex(value);

  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(HEX_PREFIX_REGEX, "");
  const expectedLength = normalizedType === "MD5" ? 32 : 40;
  return new RegExp(`^[0-9a-f]{${expectedLength}}$`, "i").test(raw) ? raw : null;
};

const normalizeExpectedChecksumValues = (
  type: JsonValue | object | undefined,
  value: JsonValue | undefined,
): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    const normalized = normalizeChecksumValue(type, item);
    return normalized ? [normalized] : [];
  });
};

const isPerWindowOutputChecksumInfo = (
  patch: PatchWithValidationInfo | null | undefined,
  info: PatchValidationInfoLike,
  type: OutputChecksumType,
): boolean => {
  if (type !== "ADLER32" || !Array.isArray(info.targetValue) || info.targetValue.length <= 1) return false;
  if (isRecord(patch) && patch.isXdeltaPatch === true) return true;

  const targetScope = String(info.targetChecksumScope || info.targetValueScope || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  return targetScope === "target-window" || targetScope === "target-windows" || targetScope === "window";
};

const getPatchOutputChecksumInfo = (patch: PatchWithValidationInfo | null | undefined): OutputChecksumInfo | null => {
  if (!patch || typeof patch.getValidationInfo !== "function") return null;
  const info = patch.getValidationInfo();
  if (!isRecord(info)) return null;
  const type = normalizeChecksumType(info.type);
  if (!type || typeof info.targetValue === "undefined" || info.targetValue === null) return null;
  if (isPerWindowOutputChecksumInfo(patch, info, type)) return null;
  const expectedValues = normalizeExpectedChecksumValues(type, info.targetValue);
  if (!expectedValues.length) return null;
  return {
    expectedValues,
    rawInfo: info,
    type,
  };
};

const getFinalPatch = (patches: VerifyPatchedOutputOptions["patches"]): PatchWithValidationInfo | null => {
  if (Array.isArray(patches)) return patches.length ? patches.at(-1) || null : null;
  return patches || null;
};

const getFinalPatchOutputChecksumInfo = (patches: VerifyPatchedOutputOptions["patches"]): OutputChecksumInfo | null =>
  getPatchOutputChecksumInfo(getFinalPatch(patches));

const getAssetBlob = (asset: VerifyPatchedOutputOptions["patchedAsset"]): Blob | null => {
  const record = isRecord(asset) ? (asset as PatchedAssetLike) : null;
  if (
    record?._file &&
    isRecord(record._file) &&
    typeof record._file.size === "number" &&
    typeof record._file.slice === "function"
  )
    return record._file;
  if (typeof Blob !== "undefined" && asset instanceof Blob) return asset;
  return null;
};

const getAssetFilePath = (asset: VerifyPatchedOutputOptions["patchedAsset"]): string | null => {
  if (!isRecord(asset)) return null;
  const filePath = (asset as PatchedAssetLike).filePath;
  return typeof filePath === "string" && filePath.trim() ? filePath : null;
};

const getAssetBytes = (asset: VerifyPatchedOutputOptions["patchedAsset"]): Uint8Array | null => {
  if (!asset) return null;
  if (isRecord(asset) && asset._u8array instanceof Uint8Array) return asset._u8array;
  if (asset instanceof Uint8Array) return asset;
  if (ArrayBuffer.isView(asset)) return new Uint8Array(asset.buffer, asset.byteOffset, asset.byteLength);
  if (asset instanceof ArrayBuffer) return new Uint8Array(asset);
  return null;
};

const getAssetSize = (asset: VerifyPatchedOutputOptions["patchedAsset"]): number => {
  const blob = getAssetBlob(asset);
  if (blob) return blob.size;
  const bytes = getAssetBytes(asset);
  if (bytes) return bytes.byteLength;
  if (isRecord(asset) && typeof asset.fileSize === "number") return asset.fileSize;
  if (isRecord(asset) && typeof asset.size === "number") return asset.size;
  return 0;
};

let defaultBrowserRuntimePromise: Promise<WorkflowRuntime> | null = null;

type BrowserRuntimeModule = {
  createBrowserRuntime: () => WorkflowRuntime;
};

const importBrowserRuntimeModule = () =>
  import("../../platform/browser/workflow-runtime.ts") as Promise<BrowserRuntimeModule>;

const resolveChecksumRuntime = async (
  asset: VerifyPatchedOutputOptions["patchedAsset"],
  runtime?: Pick<WorkflowRuntime, "checksum">,
) => {
  if (runtime?.checksum.calculate) return runtime;
  if (getAssetFilePath(asset) && typeof globalThis.Worker !== "function")
    throw new Error("Path-backed output checksum verification requires a worker-capable browser runtime");

  if (!defaultBrowserRuntimePromise) {
    defaultBrowserRuntimePromise = importBrowserRuntimeModule().then(({ createBrowserRuntime }) =>
      createBrowserRuntime(),
    );
  }
  return defaultBrowserRuntimePromise;
};

const getChecksumResultValue = (type: OutputChecksumType, result: ChecksumResult): JsonValue | undefined => {
  if (type === "ADLER32") return result.adler32;
  if (type === "CRC32") return result.crc32;
  if (type === "MD5") return result.md5;
  if (type === "SHA1") return result.sha1;
  return undefined;
};

const calculateOutputChecksumInWorker = async (
  asset: VerifyPatchedOutputOptions["patchedAsset"],
  type: OutputChecksumType,
  runtime?: Pick<WorkflowRuntime, "checksum">,
  options?: { chunkSize?: number; onProgress?: (loaded: number, total: number) => void },
): Promise<string | null> => {
  const checksumRuntime = await resolveChecksumRuntime(asset, runtime);
  const total = getAssetSize(asset);
  const onProgress = options?.onProgress;
  const result = await checksumRuntime.checksum.calculate?.({
    algorithms: [type],
    onProgress:
      typeof onProgress === "function"
        ? (progress) => {
            if (typeof progress.percent === "number" && Number.isFinite(progress.percent))
              onProgress(Math.round((Math.max(0, progress.percent) / 100) * total), total);
          }
        : undefined,
    source: asset,
  });
  if (!result) return null;
  return normalizeChecksumValue(type, getChecksumResultValue(type, result));
};

const calculateOutputChecksum = async (
  asset: VerifyPatchedOutputOptions["patchedAsset"],
  type: OutputChecksumType | string,
  runtime?: Pick<WorkflowRuntime, "checksum">,
  options?: { chunkSize?: number; onProgress?: (loaded: number, total: number) => void },
): Promise<string | null> => {
  const normalizedType = normalizeChecksumType(type);
  if (!normalizedType) throw new Error(`Unsupported output checksum type: ${type}`);
  return calculateOutputChecksumInWorker(asset, normalizedType, runtime, options);
};

const createOutputChecksumMismatchMessage = (
  result: Pick<OutputChecksumResult, "actualValue" | "expectedValues" | "type">,
): string =>
  `Output ${result.type} checksum mismatch. Expected ${result.expectedValues.join(" or ")}, got ${result.actualValue}.`;

const verifyPatchedOutputChecksum = async ({
  patchedAsset,
  patch,
  patches,
  onProgress,
  chunkSize,
  runtime,
  calculateChecksums,
}: VerifyPatchedOutputOptions): Promise<OutputChecksumResult> => {
  const info = patch ? getPatchOutputChecksumInfo(patch) : getFinalPatchOutputChecksumInfo(patches);
  if (!info) {
    return {
      actualValue: null,
      available: false,
      expectedValues: [],
      matched: true,
      message: "",
      type: "",
    };
  }

  let actualValue: string | null = null;
  if (typeof calculateChecksums === "function") {
    const results = await calculateChecksums({
      algorithms: [info.type],
      source: patchedAsset,
    });
    actualValue = normalizeChecksumValue(info.type, getChecksumResultValue(info.type, results));
  } else {
    actualValue = await calculateOutputChecksum(patchedAsset, info.type, runtime, { chunkSize, onProgress });
  }

  const matched = actualValue !== null && info.expectedValues.indexOf(actualValue) !== -1;
  const result: OutputChecksumResult = {
    actualValue,
    available: true,
    expectedValues: info.expectedValues,
    info: info.rawInfo,
    matched,
    message: "",
    type: info.type,
  };
  result.message = matched ? "" : createOutputChecksumMismatchMessage(result);
  return result;
};

export { verifyPatchedOutputChecksum };
