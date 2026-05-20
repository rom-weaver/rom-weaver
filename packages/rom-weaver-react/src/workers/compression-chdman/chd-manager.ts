const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const CUE_EXTENSION_REGEX = /\.cue$/i;
const BIN_EXTENSION_REGEX = /\.bin$/i;

/*
 * ChdManager.js
 * Shared CHD extraction helper for Rom Patcher JS.
 *
 * Uses MAME chdman compiled to WebAssembly.
 */

import { hasReadableBytes, toArrayBuffer, toUint8Array } from "../shared/binary/binary-source-utils.ts";
import { getSourceExtension, getSourceFileName, replaceFileExtension } from "../shared/binary/source-file-utils.ts";
import type { PatchFileConstructor, PatchFileLike, ProgressCallback } from "../shared/binary/types.ts";
import { getDefaultThreadCount, normalizeCodecList, normalizeThreadCount } from "../shared/compression-options.ts";
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
  createWasmToolOutput,
  formatArchiveSourceFileName,
  getPatchFileClass,
  normalizeWasmToolSource,
  notifyProgress,
  requireMountedInputOrBytes,
  runWasmTool,
  safeRemoveIfExists,
  yieldProgress,
} from "../shared/wasm-tool-runtime-utils.ts";
import { createRangeProgressCallback } from "../shared/worker-progress-utils.ts";
import {
  buildSingleTrackCue as _buildSingleTrackCue,
  getSingleTrackCdBinName as _getSingleTrackCdBinName,
  getSingleTrackCdExtractionPlan as _getSingleTrackCdExtractionPlan,
  parseChdInfo as _parseChdInfo,
  parseCueFile as _parseCueFile,
  replaceCuePatchFileName as _replaceCuePatchFileName,
  type CdExtractionPlan,
  type ChdInfo,
  type ChdResolvedMode,
  type ParsedCueFile,
} from "./chd-cue-utils.ts";
import loadChdman from "./chdman-loader.ts";

type ChdMode = "auto" | ChdResolvedMode;

type ChdSource = {
  fileName?: string;
  name?: string;
  fileSize?: number;
  _u8array?: RuntimeValue;
  _file?: RuntimeValue;
  _browserFileBacked?: boolean;
  _chdCueText?: string;
  _chdMode?: string;
  _archiveEntryName?: string;
  _archiveFileName?: string;
  readIntoAt?: RuntimeValue;
  readBytesAt?: RuntimeValue;
  materialize?: RuntimeValue;
  getExtension?: RuntimeValue;
};

type ChdProgressOptions = {
  onProgress?: ProgressCallback;
};

type ChdCreateOptions = ChdProgressOptions & {
  mode?: ChdMode;
  workId?: number | string;
  outputDirectory?: string;
  outputName?: string;
  inputPath?: string;
  allowInputBuffering?: boolean;
  cueInputPath?: string | null;
  cueText?: string;
  inputSize?: number;
  readOutput?: boolean;
  removeInput?: boolean;
  threads?: string | number | boolean | null;
  compressionCodecs?: string | string[] | number | null;
  codecs?: string | string[] | number | null;
};

type ChdExtractOptions = ChdProgressOptions & {
  mode?: ChdMode;
  workId?: number | string;
  outputDirectory?: string;
  outputName?: string;
  inputPath?: string;
  allowInputBuffering?: boolean;
  readOutput?: boolean;
  removeInput?: boolean;
  chdInfo?: ChdInfo | null;
  threads?: string | number | boolean | null;
};

type ChdCreateInfo = {
  fileName: string;
  _chdSourceFileName: string;
  _chdMode: ChdResolvedMode;
  _chdOutputPath: string;
};

type ChdExtractInfo = {
  fileName: string;
  _chdSourceFileName: string;
  _chdMode: ChdResolvedMode;
  _chdOutputPath: string;
  _chdCueText?: string;
  _chdCueFileName?: string;
  _archiveFileName: string;
  _archiveEntryName: string;
  _archiveEntryType: "rom";
};

type ChdProgressEvent = {
  label: string;
  percent: number | null;
  hasProgress?: boolean;
  resolvedFileName?: string;
};

type ChdManagerPatchFile = PatchFileLike & ChdSource & ChdCreateInfo & Partial<ChdExtractInfo>;

type ChdCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  chdExtractedMode?: ChdResolvedMode;
  chdOutputExtension?: string;
  chdCueText?: string;
  chdOutputPath?: string;
};

type ChdmanFileStream = {
  node?: RuntimeValue;
  position?: number;
};

type ChdmanFileSystem = {
  getPath?: (node: RuntimeValue) => string;
  read?: (
    stream: ChdmanFileStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position?: number | null,
  ) => number;
  write?: (
    stream: ChdmanFileStream,
    buffer: ArrayBufferView,
    offset: number,
    length: number,
    position?: number | null,
    canOwn?: boolean,
  ) => number;
};

type ChdmanRuntime = {
  FS?: ChdmanFileSystem;
  threaded?: boolean;
  threadCount?: number;
  defaultThreadCount?: number;
  supportsOnOutput?: boolean;
  exists: (filePath: string) => boolean;
  unlink: (filePath: string) => void;
  writeFile: (filePath: string, data: Uint8Array) => void;
  readFile: (filePath: string) => Uint8Array;
  run: (
    argv: string[],
    options: Record<string, RuntimeValue>,
  ) => Promise<{
    status: number;
    stdout: string;
    stderr: string;
  }>;
};

type ChdmanModuleObject = {
  wasmTool?: ChdmanRuntime;
  onRuntimeInitialized?: (...args: RuntimeValue[]) => void;
  __wasmToolThreaded?: boolean;
};

type RuntimeRoot = typeof globalThis & {
  PatchFile?: PatchFileConstructor<ChdManagerPatchFile>;
  ChdManager?: ChdManagerType;
};

type ChdManagerType = {
  isChdFile: (source: ChdSource | ArrayBuffer | ArrayBufferView) => boolean;
  getExtractedFileName: (source: ChdSource | ArrayBuffer | ArrayBufferView) => string;
  getChdFileName: (source: ChdSource | ArrayBuffer | ArrayBufferView) => string;
  getAutoCreateMode: (source: ChdSource | ArrayBuffer | ArrayBufferView) => "cd" | "dvd";
  createFromImage: (
    source: ChdSource | ArrayBuffer | ArrayBufferView,
    options?: ChdCreateOptions,
  ) => Promise<ChdManagerPatchFile | ChdCreateInfo>;
  extractToIso: (
    source: ChdSource | ArrayBuffer | ArrayBufferView,
    options?: ChdExtractOptions,
  ) => Promise<ChdManagerPatchFile | ChdExtractInfo>;
  parseCueFile: (cueText: string) => ParsedCueFile;
  parseChdInfo: (stdout: string) => ChdInfo;
  getSingleTrackCdExtractionPlan: (cueText: string) => CdExtractionPlan;
  getSingleTrackCdBinName: (cueText: string) => string;
  replaceCueBinFileName: (cueText: string, binFileName: string) => string;
  replaceCuePatchFileName: (cueText: string, binFileName: string) => string;
  buildSingleTrackCue: (binFileName: string, u8array?: { byteLength?: number } | null) => string;
  toArrayBuffer: (source: ChdSource | ArrayBuffer | ArrayBufferView) => ArrayBuffer;
};

const root: RuntimeRoot = typeof globalThis === "undefined" ? (self as RuntimeRoot) : (globalThis as RuntimeRoot);
const ChdManager = ((root, PatchFileClass, chdmanModule) => {
  const CHD_MAGIC = [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44]; // MComprHD
  const chdmanPromises = createRuntimeSelectionRecord<Promise<ChdmanRuntime> | null>(null);
  let extractionId = 0;

  const _asChdSource = (source: RuntimeValue): ChdSource | null =>
    source && (typeof source === "object" || typeof source === "function") ? (source as ChdSource) : null;
  const _getPatchFileClass = () =>
    getPatchFileClass(
      root as RuntimeValue as Parameters<typeof getPatchFileClass>[0],
      PatchFileClass as RuntimeValue as Parameters<typeof getPatchFileClass>[1],
    ) as PatchFileConstructor<ChdManagerPatchFile>;
  const _toUint8Array = (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
    toUint8Array(source, "Invalid CHD source");
  const _hasReadableBytes = hasReadableBytes;
  const _toArrayBuffer = (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
    toArrayBuffer(source, "Invalid CHD source", true);
  const _getFileName = (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
    getSourceFileName(source, { fallback: "input.chd", keys: ["fileName"] });
  const _getExtension = (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
    getSourceExtension(source, (value) => _getFileName(value as ChdSource | ArrayBuffer | ArrayBufferView));

  const _hasChdMagic = (source: ChdSource | ArrayBuffer | ArrayBufferView) => {
    const u8array = _toUint8Array(source);
    if (u8array.length < CHD_MAGIC.length) return false;

    for (let i = 0; i < CHD_MAGIC.length; i++) {
      if (u8array[i] !== CHD_MAGIC[i]) return false;
    }
    return true;
  };

  const _replaceExtension = replaceFileExtension;
  const _getPathBaseName = (filePath: string | null | undefined) => {
    const normalizedPath = String(filePath || "").replace(/\\/g, "/");
    const trimmedPath = normalizedPath.replace(TRAILING_POSIX_SLASHES_REGEX, "");
    const segments = trimmedPath.split("/");
    return segments.at(-1) || "";
  };
  const _getPathDirectory = (filePath: string | null | undefined) => {
    const normalizedPath = String(filePath || "").replace(/\\/g, "/");
    const trimmedPath = normalizedPath.replace(TRAILING_POSIX_SLASHES_REGEX, "");
    const index = trimmedPath.lastIndexOf("/");
    return index > 0 ? trimmedPath.slice(0, index) : "/";
  };
  const _getKnownExtractedExtension = (source: ChdSource | ArrayBuffer | ArrayBufferView) => {
    const sourceRecord = _asChdSource(source);
    if (sourceRecord?._chdCueText) {
      try {
        return _getSingleTrackCdExtractionPlan(sourceRecord._chdCueText).extension;
      } catch (_err) {
        return "bin";
      }
    }
    if (sourceRecord?._chdMode === "cd") return "bin";
    if (sourceRecord?._chdMode === "dvd" || sourceRecord?._chdMode === "hd" || sourceRecord?._chdMode === "raw")
      return "iso";
    return null;
  };

  const _decodeText = (data: ArrayBuffer | ArrayBufferView | ChdSource) => {
    if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(_toUint8Array(data));

    const bytes = _toUint8Array(data);
    var text = "";
    for (const item of bytes) {
      text += String.fromCharCode(item || 0);
    }
    return text;
  };

  const _getDefaultThreadCount = () => getDefaultThreadCount(root);
  const _normalizeThreadCount = (threads: string | number | boolean | null | undefined) =>
    normalizeThreadCount(threads, { allowOff: true, label: "CHD thread count" });
  const _isValidCompressionCodecLevel = (codec: string, level: number) => {
    const normalizedCodec = String(codec || "").toLowerCase();
    const maxLevel =
      normalizedCodec === "cdzs" || normalizedCodec === "zstd"
        ? 22
        : (() => {
            if (normalizedCodec === "cdfl" || normalizedCodec === "flac") {
              return 8;
            }
            if (
              normalizedCodec === "cdlz" ||
              normalizedCodec === "cdzl" ||
              normalizedCodec === "lzma" ||
              normalizedCodec === "zlib"
            ) {
              return 9;
            }
            return null;
          })();
    return maxLevel !== null && level >= 0 && level <= maxLevel;
  };
  const _normalizeCompressionCodecs = (codecs: string | string[] | number | null | undefined) =>
    normalizeCodecList(codecs, {
      allowLevels: true,
      getErrorMessage: (codec) => `Unsupported CHD codec: ${codec}`,
      getLevelErrorMessage: (codec, level) => `Unsupported CHD codec level: ${codec}:${level}`,
      isValidLevel: _isValidCompressionCodecLevel,
    });

  const _getWasmTool = (moduleObject: ChdmanModuleObject | null | undefined) => {
    if (!moduleObject) return null;
    return moduleObject.wasmTool ? moduleObject.wasmTool : null;
  };

  const _prepareChdman = (moduleObject: ChdmanModuleObject) => {
    const chdman = _getWasmTool(moduleObject);
    if (!chdman) return chdman;

    if (typeof chdman.threaded !== "boolean")
      chdman.threaded = moduleObject && moduleObject.__wasmToolThreaded === true;
    if (typeof chdman.threadCount !== "number") chdman.threadCount = chdman.threaded ? _getDefaultThreadCount() : 1;
    return chdman;
  };

  const _getCreateThreadCount = (chdman: ChdmanRuntime, options?: ChdCreateOptions) => {
    if (!chdman?.threaded) return null;
    _rememberDefaultThreadCount(chdman);
    const normalized = _normalizeThreadCount(options?.threads);
    if (normalized === 0) return null;
    if (normalized !== null) return normalized;
    return chdman.defaultThreadCount || chdman.threadCount || _getDefaultThreadCount();
  };

  const _formatThreadCount = (threads: number) => `${threads} ${threads === 1 ? "thread" : "threads"}`;
  const _rememberDefaultThreadCount = (chdman: ChdmanRuntime | null) => {
    if (!chdman) return;
    if (typeof chdman.defaultThreadCount === "number" && chdman.defaultThreadCount > 0) return;
    if (typeof chdman.threadCount === "number" && chdman.threadCount > 0)
      chdman.defaultThreadCount = chdman.threadCount;
  };
  const _configureThreadCount = (chdman: ChdmanRuntime | null, threads?: number | null) => {
    if (!chdman?.threaded) return;
    if (threads) chdman.threadCount = threads;
  };

  const _getProgressThreadCount = (
    chdman: ChdmanRuntime | null,
    options: ChdCreateOptions | ChdExtractOptions | undefined,
    operationThreads?: number | null,
  ) => {
    if (typeof operationThreads === "number" && operationThreads > 0) return operationThreads;
    if (!chdman?.threaded) return null;
    _rememberDefaultThreadCount(chdman);
    if (options && "threads" in options) {
      const normalized = _normalizeThreadCount((options as ChdCreateOptions).threads);
      if (normalized === 0) return null;
      if (normalized !== null) return normalized;
    }
    return chdman.defaultThreadCount || chdman.threadCount || _getDefaultThreadCount();
  };

  const _formatChdProgressLabel = (
    action: string,
    mode: ChdResolvedMode,
    chdman: ChdmanRuntime | null,
    options: ChdCreateOptions | ChdExtractOptions | undefined,
    operationThreads?: number | null,
  ) => {
    const typeLabel =
      mode === "cd"
        ? "CD "
        : (() => {
            if (mode === "dvd") {
              return "DVD ";
            }
            if (mode === "hd") {
              return "hard disk ";
            }
            if (mode === "raw") {
              return "raw ";
            }
            return "";
          })();
    const baseLabel = `${action} ${typeLabel}CHD`;
    const threads = _getProgressThreadCount(chdman, options, operationThreads);
    return threads ? `${baseLabel} with ${_formatThreadCount(threads)}` : baseLabel;
  };

  const _getRuntimeSelectionKey = (threads: string | number | boolean | null | undefined): RuntimeSelectionKey =>
    getRuntimeSelectionKeyFromWorkerThreads(_normalizeThreadCount(threads));

  const _getChdman = (threads?: string | number | boolean | null): Promise<ChdmanRuntime> => {
    const selectionKey = _getRuntimeSelectionKey(threads);
    return getOrCreateRuntimeSelectionValue(chdmanPromises, selectionKey, () => {
      const getModuleObject =
        typeof chdmanModule === "function"
          ? (moduleArg?: RuntimeValue) =>
              chdmanModule(moduleArg) as Promise<ChdmanModuleObject | null> | ChdmanModuleObject | null
          : () => chdmanModule as ChdmanModuleObject | null;
      const moduleArg = createRuntimeLoaderModuleArg({}, selectionKey);

      return Promise.resolve(getModuleObject(moduleArg)).then((moduleObject) => {
        if (!moduleObject) throw new Error("Rom Patcher JS: chdman-wasm not found");
        if (_getWasmTool(moduleObject)) {
          return _prepareChdman(moduleObject) as ChdmanRuntime;
        }

        return new Promise<ChdmanRuntime>((resolve) => {
          const previousOnRuntimeInitialized = moduleObject.onRuntimeInitialized;
          moduleObject.onRuntimeInitialized = function (...args: RuntimeValue[]) {
            if (previousOnRuntimeInitialized) previousOnRuntimeInitialized.call(this, ...args);
            resolve(_prepareChdman(moduleObject) as ChdmanRuntime);
          };
        });
      });
    });
  };

  const _runChdman = (chdman: ChdmanRuntime, argv: string[], options?: Record<string, RuntimeValue>) =>
    runWasmTool(
      chdman,
      argv,
      { ...(options || {}), wasmToolPhase: argv[0] || "running command" },
      "chdman failed",
    ) as Promise<ChdCommandResult>;
  const _notifyProgress = notifyProgress;
  const _createChdmanProgressAliases = (label: string, action: "Compressing" | "Extracting", mode: ChdResolvedMode) => {
    const aliases = [label, `${action} CHD`];
    if (mode === "cd") aliases.push(`${action} CD CHD`);
    else if (mode === "dvd") aliases.push(`${action} DVD CHD`);
    else if (mode === "hd") aliases.push(`${action} hard disk CHD`);
    else if (mode === "raw") aliases.push(`${action} raw CHD`);
    return aliases;
  };
  const _notifyChdmanProgress = (
    options: ChdProgressOptions | undefined,
    label: string,
    action: "Compressing" | "Extracting",
    mode: ChdResolvedMode,
    percent: number | null,
    sourceDisplayFileName?: string,
  ) =>
    options?.onProgress?.(
      createNormalizedProgressEvent(label, percent, {
        aliases: _createChdmanProgressAliases(label, action, mode),
        sourceDisplayFileName,
      }) as RuntimeValue as ChdProgressEvent,
    );
  const _createChdmanByteRangeProgressHandler = (
    options: ChdProgressOptions | undefined,
    label: string,
    action: "Compressing" | "Extracting",
    mode: ChdResolvedMode,
    totalSize: number | null | undefined,
    endPercent: number,
    sourceDisplayFileName?: string,
  ) => {
    const total = typeof totalSize === "number" && Number.isFinite(totalSize) ? Math.max(0, totalSize) : 0;
    if (!(total > 0 && typeof options?.onProgress === "function")) return null;
    return createRangeProgressCallback(label, total, 0, endPercent, (progress) =>
      _notifyChdmanProgress(options, progress.label, action, mode, progress.percent, sourceDisplayFileName),
    );
  };
  const _runChdmanWithReadProgress = (
    chdman: ChdmanRuntime,
    argv: string[],
    runOptions: Record<string, RuntimeValue>,
    inputPaths: string[],
    onReadProgress: ((rangeStart: number, rangeEnd: number) => void) | null,
  ) => {
    const FS = chdman.FS;
    const originalRead = FS?.read;
    if (!(onReadProgress && FS && typeof FS.getPath === "function" && typeof originalRead === "function")) {
      return Promise.resolve()
        .then(() => {
          onReadProgress?.(0, 1);
          return _runChdman(chdman, argv, runOptions);
        })
        .then((result) => result);
    }

    const trackedPaths = new Set(inputPaths.filter(Boolean));
    FS.read = function patchedChdmanRead(stream, buffer, offset, length, position) {
      const previousPosition = typeof stream?.position === "number" ? stream.position : 0;
      const bytesRead = originalRead.call(this, stream, buffer, offset, length, position);
      if (bytesRead > 0) {
        try {
          const filePath = stream?.node ? FS.getPath?.(stream.node) : "";
          if (filePath && trackedPaths.has(filePath)) {
            const readStart = typeof position === "number" ? position : previousPosition;
            onReadProgress(readStart, readStart + bytesRead);
          }
        } catch (_err) {
          /* ignore progress instrumentation errors */
        }
      }
      return bytesRead;
    };

    return Promise.resolve()
      .then(() => {
        onReadProgress(0, 1);
        return _runChdman(chdman, argv, runOptions);
      })
      .finally(() => {
        FS.read = originalRead;
      });
  };
  const _yieldProgress = yieldProgress;
  const _safeRemoveIfExists = safeRemoveIfExists;

  const manager: ChdManagerType = {
    buildSingleTrackCue: _buildSingleTrackCue,

    createFromImage: (source: ChdSource | ArrayBuffer | ArrayBufferView, options?: ChdCreateOptions) => {
      options = options || {};
      let mode: "auto" | "cd" | "dvd" = options.mode === "cd" || options.mode === "dvd" ? options.mode : "auto";
      if (["auto", "cd", "dvd"].indexOf(mode) === -1)
        return Promise.reject(new Error(`Unsupported CHD creation mode: ${mode}`));
      if (mode === "auto") mode = manager.getAutoCreateMode(source);

      const createId = options.workId || ++extractionId;
      const outputDirectory = options.outputDirectory
        ? String(options.outputDirectory).replace(TRAILING_POSIX_SLASHES_REGEX, "")
        : "";
      const normalizedSource = normalizeWasmToolSource(source, {
        allowInputBuffering: options.allowInputBuffering,
        fallbackFileName: `create-input-${createId}.bin`,
        fileNameKeys: ["fileName", "name", "_archiveEntryName", "_chdSourceFileName"],
        getBytes: (value) => _toUint8Array(value as ChdSource | ArrayBuffer | ArrayBufferView),
        getExtension: (value) => _getExtension(value as ChdSource | ArrayBuffer | ArrayBufferView),
        getFileSize: () => _asChdSource(source)?.fileSize,
        inputPath:
          options.inputPath ||
          (mode === "cd"
            ? `/${
                _getFileName(source)
                  .replace(/^[/\\]+|[/\\]+$/g, "")
                  .replace(/[/\\]/g, "_") || `create-input-${createId}.bin`
              }`
            : `/create-input-${createId}${_getExtension(source) ? `.${_getExtension(source)}` : ".bin"}`),
        outputPath: `${outputDirectory}/create-output-${createId}.chd`,
        shouldStageInput: !options.inputPath,
      });
      const sourceFileName =
        normalizedSource.fileName.replace(/^[/\\]+|[/\\]+$/g, "").replace(/[/\\]/g, "_") ||
        `create-input-${createId}.bin`;
      const inputPath = normalizedSource.inputPath as string;
      const cueSourceFileName = options.inputPath ? _getPathBaseName(inputPath) || sourceFileName : sourceFileName;
      const cuePath = options.cueInputPath
        ? null
        : (() => {
            if (options.inputPath) {
              return `${_getPathDirectory(inputPath)}/create-input-${createId}.cue`;
            }
            return `/create-input-${createId}.cue`;
          })();
      const outputPath = normalizedSource.outputPath as string;
      const outputName = options.outputName || manager.getChdFileName(source);
      const shouldStageInput = normalizedSource.shouldStageInput;
      try {
        requireMountedInputOrBytes(
          normalizedSource,
          "CHD input must be mounted as a filesystem path; pass inputPath or explicitly allow input buffering",
        );
      } catch (error) {
        return Promise.reject(error);
      }
      const inputBytes = shouldStageInput ? normalizedSource.bytes || _toUint8Array(source) : null;
      const inputSize = inputBytes
        ? inputBytes.byteLength
        : (() => {
            if (typeof options.inputSize === "number") {
              return options.inputSize;
            }
            return _asChdSource(source)?.fileSize || 0;
          })();

      _notifyProgress(options, "Loading CHD tools...");
      return _getChdman(options?.threads).then((chdman) => {
        const createThreads = _getCreateThreadCount(chdman, options);
        _configureThreadCount(chdman, createThreads);
        const createLabel = _formatChdProgressLabel("Compressing", mode, chdman, options, createThreads);
        if (shouldStageInput) _safeRemoveIfExists(chdman, inputPath);
        if (cuePath) _safeRemoveIfExists(chdman, cuePath);
        _safeRemoveIfExists(chdman, outputPath);

        let command: "createcd" | "createdvd";
        let inputArgPath: string = inputPath;
        if (shouldStageInput && inputBytes) chdman.writeFile(inputPath, inputBytes);
        if (mode === "cd") {
          command = "createcd";
          if (options.cueInputPath) {
            inputArgPath = options.cueInputPath;
          } else {
            const cueText = options.cueText
              ? _replaceCuePatchFileName(options.cueText, cueSourceFileName)
              : _buildSingleTrackCue(cueSourceFileName, { byteLength: inputSize });
            const cueBytes =
              typeof TextEncoder === "function"
                ? new TextEncoder().encode(cueText)
                : Uint8Array.from(cueText, (char) => char.charCodeAt(0) & 0xff);
            chdman.writeFile(cuePath as string, cueBytes);
            inputArgPath = cuePath as string;
          }
        } else {
          command = "createdvd";
        }

        _notifyProgress(options, createLabel, null);
        return _yieldProgress()
          .then(() => {
            const argv = [command, "-i", inputArgPath, "-o", outputPath, "-f"];
            const compressionCodecs = _normalizeCompressionCodecs(options.compressionCodecs || options.codecs);
            if (compressionCodecs) argv.push("-c", compressionCodecs);
            if (createThreads) argv.push("-np", String(createThreads));
            const resolvedMode = mode as ChdResolvedMode;
            const readProgress = _createChdmanByteRangeProgressHandler(
              options,
              createLabel,
              "Compressing",
              resolvedMode,
              inputSize,
              95,
              normalizedSource.sourceDisplayFileName,
            );
            return _runChdmanWithReadProgress(chdman, argv, {}, [inputPath], readProgress);
          })
          .then((_result) => {
            if (options.removeInput !== false) _safeRemoveIfExists(chdman, inputPath);
            if (cuePath) _safeRemoveIfExists(chdman, cuePath);
            const outputInfo: ChdCreateInfo = {
              _chdMode: mode as ChdResolvedMode,
              _chdOutputPath: outputPath,
              _chdSourceFileName: sourceFileName,
              fileName: outputName,
            };
            if (options.readOutput === false) {
              _notifyProgress(options, "Done", 100);
              return outputInfo;
            }

            const PatchFile = _getPatchFileClass();
            const chdFile = createWasmToolOutput({
              metadata: {
                _chdMode: outputInfo._chdMode,
                _chdSourceFileName: outputInfo._chdSourceFileName,
              },
              outputData: chdman.readFile(outputPath),
              outputName: outputInfo.fileName,
              PatchFileClass: PatchFile as RuntimeValue as Parameters<typeof createWasmToolOutput>[0]["PatchFileClass"],
              readOutput: true,
              source: normalizedSource,
            }) as ChdManagerPatchFile;
            _notifyProgress(options, "Done", 100);
            return chdFile;
          })
          .finally(() => {
            if (options.removeInput !== false) _safeRemoveIfExists(chdman, inputPath);
            if (cuePath) _safeRemoveIfExists(chdman, cuePath);
            if (options.readOutput !== false) _safeRemoveIfExists(chdman, outputPath);
          });
      });
    },

    extractToIso: (source: ChdSource | ArrayBuffer | ArrayBufferView, options?: ChdExtractOptions) => {
      options = options || {};
      const mode: ChdMode = options.mode || "auto";
      if (["auto", "raw", "hd", "cd", "dvd"].indexOf(mode) === -1)
        return Promise.reject(new Error(`Unsupported CHD extraction mode: ${mode}`));

      const workId = options.workId || ++extractionId;
      const outputDirectory = options.outputDirectory
        ? String(options.outputDirectory).replace(TRAILING_POSIX_SLASHES_REGEX, "")
        : "";
      const normalizedSource = normalizeWasmToolSource(source, {
        allowInputBuffering: options.allowInputBuffering,
        fallbackFileName: `input-${workId}.chd`,
        fileNameKeys: ["fileName", "name", "_archiveEntryName", "_chdSourceFileName"],
        getBytes: (value) => _toUint8Array(value as ChdSource | ArrayBuffer | ArrayBufferView),
        getExtension: (value) => _getExtension(value as ChdSource | ArrayBuffer | ArrayBufferView),
        getFileSize: () => _asChdSource(source)?.fileSize,
        inputPath: options.inputPath || `/input-${workId}.chd`,
        outputPath: `${outputDirectory}/output-${workId}.iso`,
        shouldStageInput: !options.inputPath,
      });
      const inputPath = normalizedSource.inputPath as string;
      const outputPath = normalizedSource.outputPath as string;
      const cuePath = `${outputDirectory}/output-${workId}.cue`;
      const binPath = `${outputDirectory}/output-${workId}.bin`;
      var outputName = options.outputName || manager.getExtractedFileName(source);
      const chdSourceFileName = normalizedSource.archiveEntryName || normalizedSource.fileName;
      const chdArchiveFileName = formatArchiveSourceFileName(normalizedSource);
      const shouldStageInput = normalizedSource.shouldStageInput;
      var chdInfo = options.chdInfo || null;
      var inputRemoved = false;
      try {
        requireMountedInputOrBytes(
          normalizedSource,
          "CHD input must be mounted as a filesystem path; pass inputPath or explicitly allow input buffering",
        );
      } catch (error) {
        return Promise.reject(error);
      }

      _notifyProgress(options, "Loading CHD tools...");
      return _getChdman(options?.threads).then((chdman) => {
        const removeInput = () => {
          if (!inputRemoved && options.removeInput !== false) {
            _safeRemoveIfExists(chdman, inputPath);
            inputRemoved = true;
          }
        };
        if (shouldStageInput) {
          _safeRemoveIfExists(chdman, inputPath);
          chdman.writeFile(inputPath, normalizedSource.bytes || _toUint8Array(source));
        }
        _safeRemoveIfExists(chdman, outputPath);
        _safeRemoveIfExists(chdman, cuePath);
        _safeRemoveIfExists(chdman, binPath);

        const getInfo = () => {
          if (chdInfo) return Promise.resolve(chdInfo);
          _notifyProgress(options, "Inspecting CHD...");
          return _yieldProgress().then(() =>
            _runChdman(chdman, ["info", "-i", inputPath]).then((result) => {
              chdInfo = _parseChdInfo(result.stdout);
              return chdInfo;
            }),
          );
        };
        const extractData = (command: "extractdvd" | "extracthd" | "extractraw", extractedMode: ChdResolvedMode) => {
          const label = _formatChdProgressLabel("Extracting", extractedMode, chdman, options);
          const readProgress = _createChdmanByteRangeProgressHandler(
            options,
            label,
            "Extracting",
            extractedMode,
            chdInfo?.logicalSize,
            95,
            normalizedSource.sourceDisplayFileName,
          );
          _notifyProgress(options, "Preparing CHD...", 5);
          return _yieldProgress()
            .then(() => {
              _notifyProgress(options, label, null);
              return _runChdmanWithReadProgress(
                chdman,
                [command, "-i", inputPath, "-o", outputPath, "-f"],
                {},
                [inputPath],
                readProgress,
              );
            })
            .then((result) => {
              result.chdExtractedMode = extractedMode;
              result.chdOutputPath = outputPath;
              return result;
            });
        };
        const extractCd = () => {
          const label = _formatChdProgressLabel("Extracting", "cd", chdman, options);
          const readProgress = _createChdmanByteRangeProgressHandler(
            options,
            label,
            "Extracting",
            "cd",
            chdInfo?.logicalSize,
            95,
            normalizedSource.sourceDisplayFileName,
          );
          _notifyProgress(options, label, null);
          return _yieldProgress().then(() =>
            _runChdmanWithReadProgress(
              chdman,
              ["extractcd", "-i", inputPath, "-o", cuePath, "-ob", binPath, "-f"],
              {},
              [inputPath],
              readProgress,
            ).then((result) => {
              const cueText = _decodeText(chdman.readFile(cuePath));
              result.chdExtractedMode = "cd";
              result.chdOutputExtension = "bin";
              result.chdCueText = cueText;
              result.chdOutputPath = binPath;
              return result;
            }),
          );
        };
        const extractForMode = (selectedMode: ChdResolvedMode) => {
          if (!options.outputName) {
            const resolvedExtension = selectedMode === "cd" ? _getKnownExtractedExtension(source) || "bin" : "iso";
            outputName = _replaceExtension(_getFileName(source), resolvedExtension);
            if (typeof options.onProgress === "function") {
              options.onProgress({
                ...createNormalizedProgressEvent("Inspecting CHD...", null, {
                  resolvedFileName: outputName,
                  sourceDisplayFileName: normalizedSource.sourceDisplayFileName,
                }),
                hasProgress: false,
              } as RuntimeValue as ChdProgressEvent);
            }
          }
          if (selectedMode === "cd") return extractCd();
          if (selectedMode === "dvd") return extractData("extractdvd", "dvd");
          if (selectedMode === "hd") return extractData("extracthd", "hd");
          return extractData("extractraw", "raw");
        };
        const shouldInspectForProgress = !chdInfo && typeof options.onProgress === "function";
        const extractPromise =
          mode === "auto" || shouldInspectForProgress
            ? getInfo().then((info) => extractForMode(mode === "auto" ? info.type : mode))
            : extractForMode(mode);

        return extractPromise
          .then((result) => {
            _notifyProgress(options, "Preparing image...", 95);
            removeInput();
            const outputInfo: ChdExtractInfo = {
              _archiveEntryName: outputName,
              _archiveEntryType: "rom",
              _archiveFileName: chdArchiveFileName,
              _chdMode: (result.chdExtractedMode || (mode === "auto" ? "raw" : mode)) as ChdResolvedMode,
              _chdOutputPath: result.chdOutputPath || outputPath,
              _chdSourceFileName: chdSourceFileName,
              fileName: outputName,
            };
            if (!options.outputName && result.chdOutputExtension)
              outputName = _replaceExtension(_getFileName(source), result.chdOutputExtension);
            outputInfo.fileName = outputName;
            if (result.chdCueText) {
              outputInfo._chdCueText = _replaceCuePatchFileName(result.chdCueText, outputName);
              outputInfo._chdCueFileName = _replaceExtension(outputName, "cue");
            }
            if (options.readOutput === false) {
              _notifyProgress(options, "Done", 100);
              return outputInfo;
            }

            const PatchFile = _getPatchFileClass();
            const binFile = createWasmToolOutput({
              metadata: {
                _chdMode: outputInfo._chdMode,
                _chdSourceFileName: outputInfo._chdSourceFileName,
                ...(outputInfo._chdCueText
                  ? {
                      _chdCueFileName: outputInfo._chdCueFileName,
                      _chdCueText: outputInfo._chdCueText,
                    }
                  : {}),
                _archiveEntryName: outputInfo._archiveEntryName,
                _archiveEntryType: outputInfo._archiveEntryType,
                _archiveFileName: outputInfo._archiveFileName,
              },
              outputData: chdman.readFile(outputInfo._chdOutputPath),
              outputName: outputInfo.fileName,
              PatchFileClass: PatchFile as RuntimeValue as Parameters<typeof createWasmToolOutput>[0]["PatchFileClass"],
              readOutput: true,
              source: normalizedSource,
            }) as ChdManagerPatchFile;
            _notifyProgress(options, "Done", 100);
            return binFile;
          })
          .finally(() => {
            removeInput();
            if (options.readOutput !== false) {
              _safeRemoveIfExists(chdman, outputPath);
              _safeRemoveIfExists(chdman, cuePath);
              _safeRemoveIfExists(chdman, binPath);
            }
          });
      });
    },

    getAutoCreateMode: (source: ChdSource | ArrayBuffer | ArrayBufferView) => {
      const sourceRecord = _asChdSource(source);
      if (sourceRecord && sourceRecord._chdMode === "cd") return "cd";
      if (sourceRecord && sourceRecord._chdMode === "dvd") return "dvd";
      if (sourceRecord?._chdCueText) return "cd";

      const fileName = _getFileName(source).toLowerCase();
      if (CUE_EXTENSION_REGEX.test(fileName) || BIN_EXTENSION_REGEX.test(fileName)) return "cd";
      return "dvd";
    },

    getChdFileName: (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
      _replaceExtension(_getFileName(source), "chd"),

    getExtractedFileName: (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
      _replaceExtension(_getFileName(source), _getKnownExtractedExtension(source) || "iso"),
    getSingleTrackCdBinName: _getSingleTrackCdBinName,
    getSingleTrackCdExtractionPlan: _getSingleTrackCdExtractionPlan,
    isChdFile: (source: ChdSource | ArrayBuffer | ArrayBufferView) =>
      _getExtension(source) === "chd" || (_hasReadableBytes(source) && _hasChdMagic(source)),
    parseChdInfo: _parseChdInfo,

    parseCueFile: _parseCueFile,
    replaceCueBinFileName: _replaceCuePatchFileName,
    replaceCuePatchFileName: _replaceCuePatchFileName,
    toArrayBuffer: _toArrayBuffer,
  };

  return manager;
})(root, PatchFile, loadChdman);

export default ChdManager;
