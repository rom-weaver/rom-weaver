const DOLPHIN_PROGRESS_PERCENT_REGEX = /(\d+(?:\.\d+)?)\s*%/;
const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;

/*
 * DolphinRvzManager.js
 * Shared RVZ conversion helper for Rom Patcher JS.
 *
 * Uses Dolphin's RVZ conversion code compiled to WebAssembly.
 */

import { hasReadableBytes, toArrayBuffer, toUint8Array } from "../shared/binary/binary-source-utils.ts";
import { getSourceExtension, getSourceFileName, replaceFileExtension } from "../shared/binary/source-file-utils.ts";
import { normalizeThreadCount } from "../shared/compression-options.ts";
import PatchFile from "../shared/file-io/patch-file.ts";
import {
  createRuntimeLoaderModuleArg,
  createRuntimeSelectionRecord,
  getOrCreateRuntimeSelectionValue,
  getRuntimeSelectionKeyFromWorkerThreads,
  type RuntimeSelectionKey,
} from "../shared/wasm/runtime-selection.ts";
import {
  createNormalizedProgressEvent,
  createProgressHandler,
  createWasmToolOutput,
  formatArchiveSourceFileName,
  getPatchFileClass,
  getProgressPercent,
  normalizeWasmToolSource,
  notifyProgress,
  removeIfExists,
  requireMountedInputOrBytes,
  runWasmTool,
  yieldProgress,
} from "../shared/wasm-tool-runtime-utils.ts";
import loadDolphinRvz from "./dolphin-rvz-loader.ts";

type RvzSource = {
  fileName?: string;
  fileSize?: number;
  _archiveEntryName?: string;
  _archiveFileName?: string;
  _rvzSourceFileName?: string;
  _rvzMode?: string;
  _u8array?: Uint8Array;
};

type RvzConvertOptions = {
  format?: "iso" | "rvz" | string;
  compression?: string;
  compressionLevel?: string | number | null;
  blockSize?: string | number | null;
  scrub?: boolean | string | number | null;
  outputName?: string | null;
  outputDirectory?: string | null;
  inputPath?: string | null;
  allowInputBuffering?: boolean;
  inputSize?: number | null;
  outputPath?: string | null;
  readOutput?: boolean;
  removeInput?: boolean;
  threads?: string | number | boolean | null;
  onProgress?: (progress: { label: string; percent: number | null }) => void;
};
type RvzSourceInput = Parameters<typeof toArrayBuffer>[0];
type RvzRunOptionValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | string[]
  | Array<{ path: string; data: Uint8Array }>
  | ((text: string) => void);

type NormalizedRvzConvertOptions = RvzConvertOptions & {
  format: "iso" | "rvz";
  compression: string;
  compressionLevel: number;
  blockSize: number;
  scrub: boolean;
  outputName: string | null;
  outputDirectory: string;
  inputPath: string | null;
  inputSize: number | null;
  outputPath: string | null;
  readOutput: boolean;
  removeInput: boolean;
};

type RvzOutputInfo = {
  fileName: string;
  _rvzSourceFileName: string;
  _rvzMode: string;
  _rvzOutputPath: string;
  _archiveFileName?: string;
  _archiveEntryName?: string;
  _archiveEntryType?: string;
};

type RvzPatchFileLike = {
  fileName: string;
  _rvzSourceFileName?: string;
  _rvzMode?: string;
  _rvzOutputFormat?: string;
  _rvzCompression?: string | null;
  _rvzCompressionLevel?: number | null;
  _rvzBlockSize?: number | null;
  _archiveFileName?: string;
  _archiveEntryName?: string;
  _archiveEntryType?: string;
};

type RvzPatchFileConstructor = new (data: ArrayBuffer) => RvzPatchFileLike;

type RvzWasmRunResult = {
  status: number;
  stdout: string;
  stderr: string;
  files?: Record<string, Uint8Array | ArrayBuffer | ArrayBufferView>;
};

type DolphinRvzModule = {
  threaded?: boolean;
  threadCount?: number;
  defaultThreadCount?: number;
  readFile: (path: string) => Uint8Array | ArrayBuffer | ArrayBufferView;
  exists: (path: string) => boolean;
  unlink: (path: string) => void;
  run: (argv: string[], options: Record<string, RuntimeValue>) => Promise<RvzWasmRunResult>;
  supportsOnOutput?: boolean;
  dolphinRvz?: DolphinRvzModule;
  Module?: DolphinRvzModule;
  onRuntimeInitialized?: (...args: RuntimeValue[]) => void;
};

type RootWithRvz = typeof globalThis & {
  __romWeaverCompressionWorkerKind?: string;
  navigator?: Navigator;
};

type DolphinRvzManagerApi = {
  isRvzFile: (source: RvzSourceInput) => boolean;
  getExtractedFileName: (source: RvzSourceInput) => string;
  getCompressedFileName: (source: RvzSourceInput) => string;
  rvzToIso: (source: RvzSourceInput, options?: RvzConvertOptions) => Promise<RvzPatchFileLike | RvzOutputInfo>;
  isoToRvz: (source: RvzSourceInput, options?: RvzConvertOptions) => Promise<RvzPatchFileLike | RvzOutputInfo>;
  convert: (source: RvzSourceInput, options?: RvzConvertOptions) => Promise<RvzPatchFileLike | RvzOutputInfo>;
  toArrayBuffer: (source: RvzSourceInput) => ArrayBuffer;
  _buildConvertArgv: (inputPath: string, outputPath: string, options: RvzConvertOptions) => string[];
  _getDolphinRvzProgressPercent: (text: string) => number | null;
  _createDolphinRvzProgressHandler: (options: RvzConvertOptions | undefined, label: string) => (text: string) => void;
  _getProgressLabel: (
    outputFormat: string,
    dolphinRvz: DolphinRvzModule,
    options?: RvzConvertOptions,
    operationThreads?: number | null,
  ) => string;
  RVZ_COMPRESSION_METHODS: string[];
};

const root = (typeof globalThis === "undefined" ? self : globalThis) as RootWithRvz;
const DolphinRvzManager = ((
  root: RootWithRvz,
  PatchFileClass: RuntimeValue,
  dolphinRvzModule: typeof loadDolphinRvz,
) => {
  const RVZ_MAGIC = [0x52, 0x56, 0x5a, 0x00]; // RVZ\0
  const DEFAULT_BLOCK_SIZE = 131072;
  const DEFAULT_COMPRESSION = "zstd";
  const DEFAULT_COMPRESSION_LEVEL = 19;
  const DOLPHIN_COMPRESSED_EXTENSIONS = ["gcz", "rvz", "wia"];
  const RVZ_COMPRESSION_METHODS = ["none", "zstd", "bzip2", "lzma", "lzma2"];

  const dolphinRvzPromises = createRuntimeSelectionRecord<Promise<DolphinRvzModule> | null>(null);
  var conversionId = 0;

  const _getPatchFileClass = () => getPatchFileClass(root, PatchFileClass as RuntimeValue) as RvzPatchFileConstructor;
  const _toUint8Array = (source: Parameters<typeof toUint8Array>[0]) => toUint8Array(source, "Invalid RVZ source");
  const _hasReadableBytes = hasReadableBytes;
  const _toArrayBuffer = (source: Parameters<typeof toArrayBuffer>[0]) => toArrayBuffer(source, "Invalid RVZ source");
  const _getFileName = (source: Parameters<typeof getSourceFileName>[0]) =>
    getSourceFileName(source, { fallback: "input.iso", keys: ["fileName", "_archiveEntryName", "_rvzSourceFileName"] });
  const _getExtension = (source: Parameters<typeof getSourceExtension>[0]) => getSourceExtension(source, _getFileName);

  const _hasRvzMagic = (source: Parameters<typeof toUint8Array>[0]) => {
    const u8array = _toUint8Array(source);
    if (u8array.length < RVZ_MAGIC.length) return false;

    for (let i = 0; i < RVZ_MAGIC.length; i++) {
      if (u8array[i] !== RVZ_MAGIC[i]) return false;
    }
    return true;
  };

  const _replaceExtension = replaceFileExtension;

  const _getRuntimeSelectionKey = (threads: string | number | boolean | null | undefined): RuntimeSelectionKey => {
    const normalizedThreads =
      threads === false || threads === 0 || threads === "0" || threads === "off"
        ? 0
        : typeof threads === "number" && Number.isFinite(threads)
          ? Math.max(1, Math.floor(threads))
          : null;
    return getRuntimeSelectionKeyFromWorkerThreads(normalizedThreads);
  };

  const _getDolphinRvz = (threads?: string | number | boolean | null): Promise<DolphinRvzModule> => {
    const selectionKey = _getRuntimeSelectionKey(threads);
    return getOrCreateRuntimeSelectionValue(dolphinRvzPromises, selectionKey, () => {
      const getModuleObject = typeof dolphinRvzModule === "function" ? dolphinRvzModule : () => dolphinRvzModule;
      const moduleArg = createRuntimeLoaderModuleArg({}, selectionKey);

      return Promise.resolve(getModuleObject(moduleArg)).then((moduleObject) => {
        if (!moduleObject) throw new Error("Rom Patcher JS: dolphin-rvz-wasm not found");
        if (moduleObject.dolphinRvz) {
          return moduleObject.dolphinRvz as RuntimeValue as DolphinRvzModule;
        }

        return new Promise<DolphinRvzModule>((resolve) => {
          const previousOnRuntimeInitialized = moduleObject.onRuntimeInitialized as
            | ((...args: RuntimeValue[]) => void)
            | undefined;
          moduleObject.onRuntimeInitialized = function (...args: RuntimeValue[]) {
            if (previousOnRuntimeInitialized) previousOnRuntimeInitialized.apply(this, args);
            resolve(moduleObject.dolphinRvz as DolphinRvzModule);
          };
        });
      });
    });
  };

  const _withBrowserHardwareConcurrency = (
    threads: string | number | boolean | null | undefined,
    callback: () => Promise<RvzWasmRunResult>,
  ) => {
    if (!threads || typeof threads !== "number" || !Number.isFinite(threads) || threads < 1) return callback();
    const navigatorObject = root?.navigator;
    if (!(navigatorObject && Object.isExtensible(navigatorObject))) return callback();

    const normalizedThreads = Math.max(1, Math.min(64, Math.floor(threads)));
    const hadOwnValue = Object.hasOwn(navigatorObject, "hardwareConcurrency");
    const previousDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, "hardwareConcurrency");
    let didOverride = false;
    try {
      Object.defineProperty(navigatorObject, "hardwareConcurrency", {
        configurable: true,
        value: normalizedThreads,
      });
      didOverride = true;
    } catch (_err) {
      return callback();
    }

    const restore = () => {
      if (!didOverride) return;
      try {
        if (hadOwnValue && previousDescriptor)
          Object.defineProperty(navigatorObject, "hardwareConcurrency", previousDescriptor);
        else delete (navigatorObject as RuntimeValue as Record<string, RuntimeValue>).hardwareConcurrency;
      } catch (_err) {
        /* ignore cleanup errors */
      }
    };

    try {
      return callback().finally(restore);
    } catch (err) {
      restore();
      throw err;
    }
  };

  const _runDolphinRvz = (dolphinRvz: DolphinRvzModule, argv: string[], options: Record<string, RvzRunOptionValue>) =>
    _withBrowserHardwareConcurrency(
      dolphinRvz?.threaded &&
        (typeof options.threads === "string" ||
          typeof options.threads === "number" ||
          typeof options.threads === "boolean" ||
          options.threads === null ||
          options.threads === undefined)
        ? options.threads
        : null,
      () =>
        runWasmTool(
          dolphinRvz,
          argv,
          { ...options, wasmToolPhase: "converting disc image" },
          "dolphin-rvz failed",
        ) as Promise<RvzWasmRunResult>,
    );

  const _normalizeIntegerOption = (value: RuntimeValue, fallback: number, min: number, max: number, label: string) => {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || String(parsed) !== String(value).trim() || parsed < min || parsed > max)
      throw new Error(`Unsupported RVZ ${label}: ${value}`);
    return parsed;
  };
  const _normalizeCompression = (compression: RuntimeValue) => {
    const normalized = String(compression || DEFAULT_COMPRESSION)
      .trim()
      .toLowerCase();
    if (RVZ_COMPRESSION_METHODS.indexOf(normalized) !== -1) return normalized;
    throw new Error(`Unsupported RVZ compression: ${compression}`);
  };
  const _normalizeThreadCount = (threads: string | number | boolean | null | undefined) =>
    normalizeThreadCount(threads, {
      allowOff: true,
      failureMessage: `Invalid RVZ thread count: ${threads}`,
      requireExactString: true,
    });
  const _formatThreadCount = (threads: number) => `${threads} ${threads === 1 ? "thread" : "threads"}`;
  const _rememberDefaultThreadCount = (dolphinRvz: DolphinRvzModule) => {
    if (typeof dolphinRvz.defaultThreadCount === "number" && dolphinRvz.defaultThreadCount > 0) return;
    if (typeof dolphinRvz.threadCount === "number" && dolphinRvz.threadCount > 0)
      dolphinRvz.defaultThreadCount = dolphinRvz.threadCount;
  };
  const _getOperationThreadCount = (dolphinRvz: DolphinRvzModule, options?: RvzConvertOptions) => {
    _rememberDefaultThreadCount(dolphinRvz);
    const normalized = _normalizeThreadCount(options?.threads);
    if (normalized === 0) return null;
    if (dolphinRvz?.threaded) return normalized || dolphinRvz.defaultThreadCount || dolphinRvz.threadCount || 1;
    return 1;
  };
  const _getProgressLabel = (
    outputFormat: string,
    dolphinRvz: DolphinRvzModule,
    options?: RvzConvertOptions,
    operationThreads?: number | null,
  ) => {
    const baseLabel = outputFormat === "iso" ? "Extracting RVZ" : "Compressing RVZ";
    const threads = operationThreads === undefined ? _getOperationThreadCount(dolphinRvz, options) : operationThreads;
    return `${baseLabel}${threads ? ` - ${_formatThreadCount(threads)}` : ""}...`;
  };
  const _configureThreadCount = (dolphinRvz: DolphinRvzModule, threads?: number | null) => {
    if (!dolphinRvz?.threaded) return;
    if (threads) dolphinRvz.threadCount = threads;
  };
  const _getDolphinRvzProgressPercent = (text: string) => getProgressPercent(text, DOLPHIN_PROGRESS_PERCENT_REGEX);
  const _notifyProgress = notifyProgress;
  const _getProgressAliases = (outputFormat: string, label: string) => [
    label,
    outputFormat === "iso" ? "Extracting RVZ" : "Compressing RVZ",
  ];
  const _createDolphinRvzProgressHandler = (
    options: RvzConvertOptions | undefined,
    label: string,
    outputFormat: "iso" | "rvz",
    sourceDisplayFileName?: string,
  ) =>
    createProgressHandler(
      {
        onProgress: (progress) =>
          options?.onProgress?.(
            createNormalizedProgressEvent(progress.label, progress.percent, {
              aliases: _getProgressAliases(outputFormat, label),
              sourceDisplayFileName,
            }),
          ),
      },
      label,
      _getDolphinRvzProgressPercent,
    );
  const _yieldProgress = yieldProgress;
  const _removeIfExists = removeIfExists;
  const _assertWorkerConversionAllowed = () => {
    if (root?.__romWeaverCompressionWorkerKind === "dolphin-rvz") return;
    throw new Error("RVZ compression and extraction must run in the RVZ worker");
  };

  const _normalizeConvertOptions = (
    options: RvzConvertOptions | undefined,
    outputFormat?: string,
  ): NormalizedRvzConvertOptions => {
    options = options || {};
    const normalized = {
      allowInputBuffering: options.allowInputBuffering === true,
      blockSize: _normalizeIntegerOption(
        options.blockSize,
        DEFAULT_BLOCK_SIZE,
        1,
        Number.MAX_SAFE_INTEGER || 9007199254740991,
        "block size",
      ),
      compression: _normalizeCompression(options.compression),
      compressionLevel: _normalizeIntegerOption(
        options.compressionLevel,
        DEFAULT_COMPRESSION_LEVEL,
        0,
        22,
        "compression level",
      ),
      format: outputFormat || options.format || "rvz",
      inputPath: options.inputPath || null,
      inputSize: typeof options.inputSize === "number" ? options.inputSize : null,
      outputDirectory: options.outputDirectory
        ? String(options.outputDirectory).replace(TRAILING_POSIX_SLASHES_REGEX, "")
        : "",
      outputName: options.outputName || null,
      outputPath: options.outputPath || null,
      readOutput: options.readOutput !== false,
      removeInput: options.removeInput !== false,
      scrub: !!options.scrub,
      threads: options.threads,
    };

    if (normalized.format !== "iso" && normalized.format !== "rvz")
      throw new Error(`Unsupported RVZ conversion format: ${normalized.format}`);
    return normalized as NormalizedRvzConvertOptions;
  };

  const _buildConvertArgv = (inputPath: string, outputPath: string, options: NormalizedRvzConvertOptions) => {
    const argv = ["convert", "-i", inputPath, "-o", outputPath, "-f", options.format];

    if (options.scrub) argv.push("-s");

    if (options.format === "rvz") {
      argv.push("-b", String(options.blockSize));
      argv.push("-c", options.compression);
      argv.push("-l", String(options.compressionLevel));
    }

    return argv;
  };

  const _convertInMemory = (source: RvzSource, outputFormat: string, options?: RvzConvertOptions) => {
    const normalizedOptions = _normalizeConvertOptions(options, outputFormat);
    const id = ++conversionId;
    const normalizedSource = normalizeWasmToolSource(source, {
      allowInputBuffering: normalizedOptions.allowInputBuffering,
      fallbackFileName: outputFormat === "iso" ? "input.rvz" : "input.iso",
      fileNameKeys: ["fileName", "_archiveEntryName", "_rvzSourceFileName"],
      getBytes: (value) => _toUint8Array(value as Parameters<typeof toUint8Array>[0]),
      getExtension: (value) => _getExtension(value as Parameters<typeof getSourceExtension>[0]),
      getFileSize: () => source.fileSize || normalizedOptions.inputSize,
      inputPath:
        normalizedOptions.inputPath ||
        `rvz-input-${id}.${_getExtension(source) || (outputFormat === "iso" ? "rvz" : "iso")}`,
      outputPath:
        normalizedOptions.outputPath ||
        (normalizedOptions.outputDirectory
          ? `${normalizedOptions.outputDirectory}/rvz-output-${id}.${normalizedOptions.format}`
          : `rvz-output-${id}.${normalizedOptions.format}`),
      shouldStageInput: !normalizedOptions.inputPath,
    });
    const inputPath = normalizedSource.inputPath as string;
    const outputPath = normalizedSource.outputPath as string;
    const outputName =
      normalizedOptions.outputName || _replaceExtension(normalizedSource.fileName, normalizedOptions.format);
    const shouldStageInput = normalizedSource.shouldStageInput;
    try {
      requireMountedInputOrBytes(
        normalizedSource,
        "RVZ input must be mounted as a filesystem path; pass inputPath or explicitly allow input buffering",
      );
    } catch (error) {
      return Promise.reject(error);
    }
    _notifyProgress(options, "Loading RVZ tools...", 0);
    return _getDolphinRvz(normalizedOptions.threads).then((dolphinRvz) => {
      const operationThreads = _getOperationThreadCount(dolphinRvz, normalizedOptions);
      _configureThreadCount(dolphinRvz, operationThreads);
      const operationLabel = _getProgressLabel(
        normalizedOptions.format,
        dolphinRvz,
        normalizedOptions,
        operationThreads,
      );
      if (shouldStageInput) _removeIfExists(dolphinRvz, inputPath);
      _removeIfExists(dolphinRvz, outputPath);
      _notifyProgress(options, operationLabel, null);
      return _yieldProgress()
        .then(() =>
          _runDolphinRvz(dolphinRvz, _buildConvertArgv(inputPath, outputPath, normalizedOptions), {
            files: shouldStageInput
              ? [{ data: normalizedSource.bytes || _toUint8Array(source), path: inputPath }]
              : null,
            onOutput: _createDolphinRvzProgressHandler(
              options,
              operationLabel,
              normalizedOptions.format,
              normalizedSource.sourceDisplayFileName,
            ),
            outputs: normalizedOptions.readOutput ? [outputPath] : null,
            threads: operationThreads,
          }),
        )
        .then((result) => {
          const outputInfo: RvzOutputInfo = {
            _rvzMode: source?._rvzMode
              ? source._rvzMode
              : (() => {
                  if (normalizedOptions.format === "iso") {
                    return "rvz";
                  }
                  return "iso";
                })(),
            _rvzOutputPath: outputPath,
            _rvzSourceFileName: source?._rvzSourceFileName ? source._rvzSourceFileName : normalizedSource.fileName,
            fileName: outputName,
          };
          if (normalizedSource.archiveFileName)
            outputInfo._archiveFileName = formatArchiveSourceFileName(normalizedSource);
          if (normalizedOptions.format === "iso") {
            outputInfo._archiveEntryName = outputName;
            outputInfo._archiveEntryType = "rom";
          }
          if (!normalizedOptions.readOutput) {
            _notifyProgress(options, "Done", 100);
            return outputInfo;
          }

          const PatchFile = _getPatchFileClass();
          const outputData = result.files?.[outputPath] ? result.files[outputPath] : dolphinRvz.readFile(outputPath);
          const convertedFile = createWasmToolOutput({
            metadata: {
              _rvzBlockSize: normalizedOptions.format === "rvz" ? normalizedOptions.blockSize : null,
              _rvzCompression: normalizedOptions.format === "rvz" ? normalizedOptions.compression : null,
              _rvzCompressionLevel: normalizedOptions.format === "rvz" ? normalizedOptions.compressionLevel : null,
              _rvzMode: outputInfo._rvzMode,
              _rvzOutputFormat: normalizedOptions.format,
              _rvzSourceFileName: outputInfo._rvzSourceFileName,
              ...(outputInfo._archiveFileName ? { _archiveFileName: outputInfo._archiveFileName } : {}),
              ...(outputInfo._archiveEntryName ? { _archiveEntryName: outputInfo._archiveEntryName } : {}),
              ...(outputInfo._archiveEntryType ? { _archiveEntryType: outputInfo._archiveEntryType } : {}),
            },
            outputData: outputData,
            outputName: outputInfo.fileName,
            PatchFileClass: PatchFile as RuntimeValue as Parameters<typeof createWasmToolOutput>[0]["PatchFileClass"],
            readOutput: true,
            source: normalizedSource,
          }) as RvzPatchFileLike;
          _notifyProgress(options, "Done", 100);
          return convertedFile;
        })
        .finally(() => {
          if (shouldStageInput && normalizedOptions.removeInput) _removeIfExists(dolphinRvz, inputPath);
          if (normalizedOptions.readOutput) _removeIfExists(dolphinRvz, outputPath);
        });
    });
  };

  const manager = {
    _buildConvertArgv: _buildConvertArgv,
    _createDolphinRvzProgressHandler: _createDolphinRvzProgressHandler,
    _getDolphinRvzProgressPercent: _getDolphinRvzProgressPercent,
    _getProgressLabel: _getProgressLabel,

    convert: (source: RvzSourceInput, options?: RvzConvertOptions) => {
      _assertWorkerConversionAllowed();
      options = options || {};
      return _convertInMemory(source as RvzSource, options.format || "rvz", options);
    },

    getCompressedFileName: (source: RvzSourceInput) => _replaceExtension(_getFileName(source), "rvz"),

    getExtractedFileName: (source: RvzSourceInput) => _replaceExtension(_getFileName(source), "iso"),

    isoToRvz: (source: RvzSourceInput, options?: RvzConvertOptions) => {
      _assertWorkerConversionAllowed();
      options = options || {};
      if (!options.outputName) options.outputName = manager.getCompressedFileName(source);
      return _convertInMemory(source as RvzSource, "rvz", options);
    },
    isRvzFile: (source: RvzSourceInput) =>
      DOLPHIN_COMPRESSED_EXTENSIONS.indexOf(_getExtension(source)) !== -1 ||
      (_hasReadableBytes(source) && _hasRvzMagic(source)),
    RVZ_COMPRESSION_METHODS: RVZ_COMPRESSION_METHODS,

    rvzToIso: (source: RvzSourceInput, options?: RvzConvertOptions) => {
      _assertWorkerConversionAllowed();
      options = options || {};
      if (!options.outputName) options.outputName = manager.getExtractedFileName(source);
      return _convertInMemory(source as RvzSource, "iso", options);
    },

    toArrayBuffer: _toArrayBuffer,
  };

  return manager;
})(root, PatchFile, loadDolphinRvz) as DolphinRvzManagerApi;

export default DolphinRvzManager;
