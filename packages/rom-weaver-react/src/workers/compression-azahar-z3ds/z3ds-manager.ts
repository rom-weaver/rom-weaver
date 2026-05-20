/*
 * Z3dsManager.js
 * Shared Z3DS compression/decompression helper for Rom Patcher JS.
 *
 * Uses Azahar's standalone Z3DS WebAssembly module.
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
  createWasmToolError,
  createWasmToolOutput,
  getPatchFileClass,
  normalizeWasmToolSource,
  notifyProgress,
  yieldProgress,
} from "../shared/wasm-tool-runtime-utils.ts";
import loadAzaharZ3ds from "./azahar-z3ds-loader.ts";

type SourceWithFileMetadata = {
  fileName?: string;
  name?: string;
  _archiveEntryName?: string;
  _z3dsSourceFileName?: string;
  _file?: Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  _u8array?: Uint8Array;
  _z3dsUnderlyingMagic?: string;
};

type Z3dsInspectInfo = {
  isCompressed?: boolean;
  underlyingMagic?: string;
  compressedSize?: number;
  metadataSize?: number;
  metadata?: Record<string, RuntimeValue>;
  uncompressedSize?: number;
  recommendedExtension?: string;
  recommendedFileName?: string;
};

type Z3dsMetadataRecord = Record<string, Uint8Array>;

type Z3dsOptions = {
  inputPath?: string | null;
  outputPath?: string | null;
  outputName?: string;
  archiveFileName?: string;
  onProgress?: (progress: { label: string; percent: number | null }) => void;
  threads?: string | number | boolean | null;
  compressedExtension?: string;
  underlyingMagic?: string;
  metadata?: Record<string, RuntimeValue> | null;
  frameSize?: string | number | null;
  compressionLevel?: string | number | null;
  readOutput?: boolean;
};
type Z3dsSourceInput = Parameters<typeof toArrayBuffer>[0];

type Z3dsModule = {
  __romWeaverWasmAbort?: RuntimeValue | null;
  inspect: (input: Uint8Array) => Z3dsInspectInfo | null | undefined;
  inspectPath?: (inputPath: string) => Z3dsInspectInfo | null | undefined;
  decompress: (input: Uint8Array, workerCount: number) => Uint8Array | ArrayBuffer | ArrayBufferView;
  decompressPath?: (inputPath: string, outputPath: string, workerCount: number) => boolean | void;
  compress: (
    input: Uint8Array,
    underlyingMagic: string,
    frameSize: number,
    metadata: Z3dsMetadataRecord,
    workerCount: number,
    compressionLevel: number | null,
  ) => Uint8Array | ArrayBuffer | ArrayBufferView;
  compressPath?: (
    inputPath: string,
    outputPath: string,
    underlyingMagic: string,
    frameSize: number,
    metadata: Z3dsMetadataRecord,
    workerCount: number,
    compressionLevel: number | null,
  ) => boolean | void;
  __azaharZ3dsThreaded?: boolean;
  __azaharZ3dsSelectionReason?: string;
  threadCount?: number;
  threaded?: boolean;
  selectionReason?: string;
  wasmToolName?: string;
  FS?: {
    read?: (...args: RuntimeValue[]) => RuntimeValue;
    write?: (...args: RuntimeValue[]) => RuntimeValue;
    stat?: (filePath: string) => { size?: number } | null | undefined;
  };
};

type PatchFileLike = {
  fileName: string;
  _z3dsSourceFileName?: string;
  _z3dsUnderlyingMagic?: string;
  _z3dsMetadata?: Z3dsMetadataRecord;
  _z3dsCompressionInfo?: Z3dsInspectInfo | null;
  _z3dsCompressedExtension?: string;
  _archiveFileName?: string;
  _archiveEntryName?: string;
  _archiveEntryType?: string;
};

type PatchFileConstructorLike = new (data: ArrayBuffer) => PatchFileLike;

type RootWithModules = typeof globalThis;
type NormalizedZ3dsSource = ReturnType<typeof normalizeWasmToolSource>;

type Z3dsManagerApi = {
  isZ3dsFile: (source: Z3dsSourceInput) => boolean;
  getExtractedFileName: (source: Z3dsSourceInput, info?: Z3dsInspectInfo | null) => string;
  getCompressedFileName: (source: Z3dsSourceInput, options?: Z3dsOptions) => string;
  getUnderlyingMagicForSource: (source: Z3dsSourceInput, fallbackExtension?: string) => string;
  inspect: (source: Z3dsSourceInput) => Promise<Z3dsInspectInfo>;
  decompress: (source: Z3dsSourceInput, options?: Z3dsOptions) => Promise<PatchFileLike>;
  compress: (source: Z3dsSourceInput, options?: Z3dsOptions) => Promise<PatchFileLike>;
  getFormatLabel: (source: Z3dsSourceInput, info?: Z3dsInspectInfo | null) => string;
  toArrayBuffer: (source: Z3dsSourceInput) => ArrayBuffer;
};

const root = (typeof globalThis === "undefined" ? self : globalThis) as RootWithModules;
const Z3dsManager = ((root: RootWithModules, PatchFileClass: RuntimeValue, azaharZ3dsModule: typeof loadAzaharZ3ds) => {
  const Z3DS_MAGIC = [0x5a, 0x33, 0x44, 0x53]; // Z3DS
  const DEFAULT_FRAME_SIZE = 0;
  const COMPRESSED_EXTENSION_BY_RAW_EXTENSION = {
    "3ds": "z3ds",
    "3dsx": "z3dsx",
    app: "zcxi",
    cci: "zcci",
    cia: "zcia",
    cxi: "zcxi",
  };
  const RAW_EXTENSION_BY_COMPRESSED_EXTENSION = {
    z3ds: "3ds",
    z3dsx: "3dsx",
    zcci: "cci",
    zcia: "cia",
    zcxi: "cxi",
  };
  const UNDERLYING_MAGIC_BY_RAW_EXTENSION = {
    "3ds": "NCSD",
    "3dsx": "3DSX",
    app: "NCCH",
    cci: "NCSD",
    cia: "CIA\u0000",
    cxi: "NCCH",
  };
  const RAW_EXTENSION_BY_UNDERLYING_MAGIC = {
    "3DSX": "3dsx",
    "CIA\u0000": "cia",
    NCCH: "cxi",
    NCSD: "cci",
  };

  const azaharZ3dsPromises = createRuntimeSelectionRecord<Promise<Z3dsModule> | null>(null);

  const _getPatchFileClass = () => getPatchFileClass(root, PatchFileClass as RuntimeValue) as PatchFileConstructorLike;
  const _hasReadableBytes = hasReadableBytes;
  const _toArrayBuffer = (source: Parameters<typeof toArrayBuffer>[0]) =>
    toArrayBuffer(source, "Invalid Z3DS source", true);
  const _getFileName = (source: Parameters<typeof getSourceFileName>[0]) =>
    getSourceFileName(source, {
      fallback: "input.bin",
      keys: ["fileName", "name", "_archiveEntryName", "_z3dsSourceFileName"],
    });
  const _getExtension = (source: Parameters<typeof getSourceExtension>[0]) => getSourceExtension(source, _getFileName);
  const _replaceExtension = replaceFileExtension;
  const _notifyProgress = notifyProgress;
  const _yieldProgress = yieldProgress;
  const _getFsStreamPath = (stream: RuntimeValue): string => {
    if (!stream || typeof stream !== "object") return "";
    const streamPath = (stream as { path?: RuntimeValue }).path;
    return typeof streamPath === "string" ? streamPath : "";
  };
  const _matchesFsPath = (leftPath: RuntimeValue, rightPath: RuntimeValue) =>
    typeof leftPath === "string" && !!leftPath && typeof rightPath === "string" && leftPath === rightPath;
  const _toPositiveNumber = (value: RuntimeValue): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  const _getPathSize = (
    azaharZ3ds: Z3dsModule,
    filePath: string | null | undefined,
    fallbackSize: RuntimeValue,
  ): number | null => {
    const fallback = _toPositiveNumber(fallbackSize);
    if (fallback !== null) return fallback;
    if (!(filePath && azaharZ3ds?.FS) || typeof azaharZ3ds.FS.stat !== "function") return null;
    try {
      const stats = azaharZ3ds.FS.stat(filePath);
      return _toPositiveNumber(stats?.size);
    } catch (_error) {
      return null;
    }
  };
  const _createProgressEmitter = (
    options: Z3dsOptions,
    label: string,
    normalizedSource: NormalizedZ3dsSource,
    aliases: string[],
  ) => {
    let lastPercent = 0;
    let lastEmitAt = 0;
    return (nextPercent: RuntimeValue) => {
      const percentValue = _toPositiveNumber(nextPercent);
      if (percentValue === null) return;
      const normalizedPercent = Math.min(99, Math.max(1, Math.floor(percentValue)));
      if (normalizedPercent <= lastPercent) return;
      const now = Date.now();
      if (normalizedPercent < 99 && now - lastEmitAt < 50) return;
      lastPercent = normalizedPercent;
      lastEmitAt = now;
      options.onProgress?.(
        createNormalizedProgressEvent(label, normalizedPercent, {
          aliases,
          sourceDisplayFileName: normalizedSource.sourceDisplayFileName,
        }),
      );
    };
  };
  const _runPathOperationWithFsProgress = ({
    azaharZ3ds,
    operation,
    onReadBytes,
    onWriteBytes,
    readPath,
    writePath,
  }: {
    azaharZ3ds: Z3dsModule;
    operation: () => void;
    onReadBytes?: (readBytes: number) => void;
    onWriteBytes?: (writtenBytes: number) => void;
    readPath?: string | null;
    writePath?: string | null;
  }) => {
    const fs = azaharZ3ds?.FS;
    const originalRead = fs?.read;
    const originalWrite = fs?.write;
    if ((!readPath || typeof originalRead !== "function") && (!writePath || typeof originalWrite !== "function")) {
      operation();
      return;
    }

    if (fs && readPath && typeof originalRead === "function") {
      fs.read = (...args: RuntimeValue[]) => {
        const result = originalRead.apply(fs, args);
        const streamPath = _getFsStreamPath(args[0]);
        const fallbackReadBytes = typeof args[3] === "number" ? args[3] : 0;
        const bytesRead = typeof result === "number" ? result : fallbackReadBytes;
        if (_matchesFsPath(streamPath, readPath) && typeof bytesRead === "number" && bytesRead > 0)
          onReadBytes?.(bytesRead);
        return result;
      };
    }

    if (fs && writePath && typeof originalWrite === "function") {
      fs.write = (...args: RuntimeValue[]) => {
        const result = originalWrite.apply(fs, args);
        const streamPath = _getFsStreamPath(args[0]);
        const fallbackWriteBytes = typeof args[3] === "number" ? args[3] : 0;
        const bytesWritten = typeof result === "number" ? result : fallbackWriteBytes;
        if (_matchesFsPath(streamPath, writePath) && typeof bytesWritten === "number" && bytesWritten > 0)
          onWriteBytes?.(bytesWritten);
        return result;
      };
    }

    try {
      operation();
    } finally {
      if (fs && typeof originalRead === "function") fs.read = originalRead;
      if (fs && typeof originalWrite === "function") fs.write = originalWrite;
    }
  };

  const _toUint8ArrayAsync = async (source: Parameters<typeof toUint8Array>[0]) => {
    const sourceRecord = source as SourceWithFileMetadata | null | undefined;
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source) || sourceRecord?._u8array)
      return toUint8Array(source, "Invalid Z3DS source");
    if (source && typeof (source as Blob).arrayBuffer === "function")
      return new Uint8Array(await (source as Blob).arrayBuffer());
    if (sourceRecord?._file && typeof sourceRecord._file.arrayBuffer === "function")
      return new Uint8Array(await sourceRecord._file.arrayBuffer());
    throw new Error("Invalid Z3DS source");
  };

  const _normalizeUnderlyingMagic = (magic: string | null | undefined) => {
    const normalized = String(magic || "");
    if (normalized.length !== 4) throw new Error(`Unsupported Z3DS underlying magic: ${magic}`);
    return normalized;
  };

  const _normalizeThreadCount = (threads: string | number | boolean | null | undefined) =>
    normalizeThreadCount(threads, {
      allowOff: true,
      failureMessage: `Invalid Z3DS thread count: ${threads}`,
      requireExactString: true,
    });
  const _normalizeCompressionLevel = (compressionLevel: string | number | null | undefined) => {
    if (
      compressionLevel === undefined ||
      compressionLevel === null ||
      compressionLevel === "" ||
      compressionLevel === "default"
    )
      return null;
    const parsed = parseInt(String(compressionLevel), 10);
    if (!Number.isFinite(parsed) || String(parsed) !== String(compressionLevel).trim() || parsed < 0 || parsed > 22)
      throw new Error(`Invalid Z3DS compression level: ${compressionLevel}`);
    return parsed;
  };

  const _getRuntimeSelectionKey = (threads: string | number | boolean | null | undefined): RuntimeSelectionKey =>
    getRuntimeSelectionKeyFromWorkerThreads(_normalizeThreadCount(threads));

  const _getAzaharZ3ds = (threads?: string | number | boolean | null): Promise<Z3dsModule> => {
    const runtimeSelectionKey = _getRuntimeSelectionKey(threads);
    return getOrCreateRuntimeSelectionValue(azaharZ3dsPromises, runtimeSelectionKey, () => {
      const getModuleObject = typeof azaharZ3dsModule === "function" ? azaharZ3dsModule : () => azaharZ3dsModule;
      const moduleArg = createRuntimeLoaderModuleArg({}, runtimeSelectionKey);
      return Promise.resolve(getModuleObject(moduleArg)).then((moduleObject) => {
        if (!moduleObject) throw new Error("Rom Patcher JS: azahar-z3ds-wasm not found");
        const z3dsModule = moduleObject as RuntimeValue as Z3dsModule;
        z3dsModule.wasmToolName = "azahar-z3ds";
        z3dsModule.threaded = z3dsModule.__azaharZ3dsThreaded === true;
        z3dsModule.selectionReason = z3dsModule.__azaharZ3dsSelectionReason || "";
        return z3dsModule;
      });
    });
  };

  const _normalizeZ3dsRuntimeError = (azaharZ3ds: Z3dsModule, phase: string, caughtError: RuntimeValue) =>
    createWasmToolError({
      argv: [phase],
      cause: caughtError,
      fallbackMessage: "azahar-z3ds failed",
      phase,
      status: null,
      tool: azaharZ3ds as RuntimeValue as Parameters<typeof createWasmToolError>[0]["tool"],
    });
  const _normalizeSource = (source: Z3dsSourceInput, fallbackFileName: string) =>
    normalizeWasmToolSource(source, {
      fallbackFileName,
      fileNameKeys: ["fileName", "name", "_archiveEntryName", "_z3dsSourceFileName"],
      getExtension: (value) => _getExtension(value as Z3dsSourceInput),
      getFileSize: () => (source as { fileSize?: number } | null | undefined)?.fileSize,
    });
  const _createOutputPatchFile = (
    azaharZ3ds: Z3dsModule,
    phase: string,
    outputName: string,
    normalizedSource: NormalizedZ3dsSource,
    operation: () => Uint8Array | ArrayBuffer | ArrayBufferView,
  ) => {
    let outputData: Uint8Array | ArrayBuffer | ArrayBufferView;
    try {
      outputData = operation();
    } catch (error) {
      throw _normalizeZ3dsRuntimeError(azaharZ3ds, phase, error);
    }
    const PatchFile = _getPatchFileClass();
    return createWasmToolOutput({
      metadata: {},
      outputData,
      outputName,
      PatchFileClass: PatchFile as RuntimeValue as Parameters<typeof createWasmToolOutput>[0]["PatchFileClass"],
      readOutput: true,
      source: normalizedSource,
    }) as PatchFileLike;
  };
  const _createPathOutputInfo = (
    outputName: string,
    normalizedSource: NormalizedZ3dsSource,
    outputPath: string | null | undefined,
  ) =>
    ({
      _z3dsOutputPath: outputPath || "",
      fileName: outputName,
      fileSize: normalizedSource.fileSize || 0,
    }) as PatchFileLike;
  const _getCompressionWorkerCount = (
    moduleObject: Z3dsModule,
    threads: string | number | boolean | null | undefined,
  ) => {
    const normalizedThreads = _normalizeThreadCount(threads);
    if (!moduleObject?.__azaharZ3dsThreaded || normalizedThreads === 0) return 0;
    return normalizedThreads || moduleObject.threadCount || 1;
  };
  const _getDecompressionWorkerCount = (
    moduleObject: Z3dsModule,
    threads: string | number | boolean | null | undefined,
  ) => {
    const compressionWorkerCount = _getCompressionWorkerCount(moduleObject, threads);
    return compressionWorkerCount > 1 ? compressionWorkerCount : 0;
  };

  const _hasZ3dsMagic = (source: Parameters<typeof toArrayBuffer>[0]) => {
    const u8array = toUint8Array(source, "Invalid Z3DS source");
    if (u8array.length < Z3DS_MAGIC.length) return false;
    for (let i = 0; i < Z3DS_MAGIC.length; i++) {
      if (u8array[i] !== Z3DS_MAGIC[i]) return false;
    }
    return true;
  };

  const _cleanUnderlyingMagic = (value: RuntimeValue) =>
    String(value || "")
      .split("\u0000")
      .join("");

  const _getRawExtensionFromInspectInfo = (info: Z3dsInspectInfo | null | undefined, fallbackExtension?: string) => {
    const normalizedFallback = String(fallbackExtension || "").toLowerCase();
    const extensionFromCompressed =
      RAW_EXTENSION_BY_COMPRESSED_EXTENSION[normalizedFallback as keyof typeof RAW_EXTENSION_BY_COMPRESSED_EXTENSION];
    if (extensionFromCompressed) return extensionFromCompressed;
    if (COMPRESSED_EXTENSION_BY_RAW_EXTENSION[normalizedFallback as keyof typeof COMPRESSED_EXTENSION_BY_RAW_EXTENSION])
      return normalizedFallback;
    const extensionFromMagic =
      RAW_EXTENSION_BY_UNDERLYING_MAGIC[
        String(info?.underlyingMagic || "") as keyof typeof RAW_EXTENSION_BY_UNDERLYING_MAGIC
      ];
    if (extensionFromMagic) return extensionFromMagic;
    return "bin";
  };

  const _getCompressedExtensionForSource = (source: Z3dsSourceInput, fallbackExtension?: string) => {
    const extension = String(fallbackExtension || _getExtension(source) || "").toLowerCase();
    const compressedExtension =
      COMPRESSED_EXTENSION_BY_RAW_EXTENSION[extension as keyof typeof COMPRESSED_EXTENSION_BY_RAW_EXTENSION];
    if (!compressedExtension) throw new Error(`Unsupported Z3DS source extension: ${extension || "(missing)"}`);
    return compressedExtension;
  };

  const _getUnderlyingMagicForSource = (source: Z3dsSourceInput, fallbackExtension?: string) => {
    const extension = String(fallbackExtension || _getExtension(source) || "").toLowerCase();
    const underlyingMagic =
      UNDERLYING_MAGIC_BY_RAW_EXTENSION[extension as keyof typeof UNDERLYING_MAGIC_BY_RAW_EXTENSION];
    if (!underlyingMagic) throw new Error(`Unsupported Z3DS source extension: ${extension || "(missing)"}`);
    return underlyingMagic;
  };

  const _decorateDecompressedPatchFile = (
    binFile: PatchFileLike,
    sourceFileName: string,
    outputName: string,
    info: Z3dsInspectInfo | null | undefined,
    options?: Z3dsOptions,
  ) => {
    binFile.fileName = outputName;
    binFile._z3dsSourceFileName = sourceFileName;
    binFile._z3dsUnderlyingMagic = _normalizeUnderlyingMagic(
      info?.underlyingMagic || _getUnderlyingMagicForSource({ fileName: outputName }),
    );
    binFile._z3dsMetadata = _toMetadataRecord(
      info?.metadata as Record<string, ArrayBuffer | ArrayBufferView | Uint8Array | null | undefined> | undefined,
    );
    binFile._z3dsCompressionInfo = info || null;
    if (options?.archiveFileName) binFile._archiveFileName = options.archiveFileName;
    binFile._archiveEntryName = outputName;
    binFile._archiveEntryType = "rom";
    return binFile;
  };

  const _decorateCompressedPatchFile = (
    binFile: PatchFileLike,
    sourceFileName: string,
    outputName: string,
    underlyingMagic: string,
    metadata: Z3dsMetadataRecord,
    options?: Z3dsOptions,
  ) => {
    binFile.fileName = outputName;
    binFile._z3dsSourceFileName = sourceFileName;
    binFile._z3dsUnderlyingMagic = underlyingMagic;
    binFile._z3dsMetadata = metadata || {};
    binFile._z3dsCompressedExtension = _getExtension({ fileName: outputName });
    if (options?.archiveFileName) binFile._archiveFileName = options.archiveFileName;
    binFile._archiveEntryName = outputName;
    binFile._archiveEntryType = "rom";
    return binFile;
  };

  const _toMetadataRecord = (
    metadata: Record<string, ArrayBuffer | ArrayBufferView | Uint8Array | null | undefined> | null | undefined,
  ): Z3dsMetadataRecord => {
    if (!metadata || typeof metadata !== "object") return {};
    const normalized: Z3dsMetadataRecord = {};
    for (const key of Object.keys(metadata)) {
      const value = metadata[key];
      if (value instanceof Uint8Array) normalized[key] = value;
      else if (value instanceof ArrayBuffer) normalized[key] = new Uint8Array(value);
      else if (ArrayBuffer.isView(value))
        normalized[key] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return normalized;
  };

  const manager = {
    compress: async (source: Z3dsSourceInput, options?: Z3dsOptions) => {
      options = options || {};
      const normalizedSource = _normalizeSource(source, "input.bin");
      if (!options.inputPath) throw new Error("Z3DS compression requires a filesystem-backed inputPath (NodeFS/OPFS)");
      const sourceFileName = normalizedSource.fileName;
      const fallbackExtension = _getExtension(source);
      const underlyingMagic = _normalizeUnderlyingMagic(
        options.underlyingMagic || _getUnderlyingMagicForSource(source, fallbackExtension),
      );
      const compressedExtension =
        options.compressedExtension ||
        COMPRESSED_EXTENSION_BY_RAW_EXTENSION[
          _getRawExtensionFromInspectInfo(
            { underlyingMagic },
            fallbackExtension,
          ) as keyof typeof COMPRESSED_EXTENSION_BY_RAW_EXTENSION
        ] ||
        _getCompressedExtensionForSource(source, fallbackExtension);
      const outputName = options.outputName || _replaceExtension(sourceFileName, compressedExtension);
      const metadata = _toMetadataRecord(
        options.metadata as Record<string, ArrayBuffer | ArrayBufferView | Uint8Array | null | undefined> | undefined,
      );
      const frameSize =
        options.frameSize === undefined || options.frameSize === null ? DEFAULT_FRAME_SIZE : Number(options.frameSize);
      if (!Number.isFinite(frameSize) || frameSize < 0)
        throw new Error(`Invalid Z3DS frame size: ${options.frameSize}`);
      const compressionLevel = _normalizeCompressionLevel(options.compressionLevel);
      _notifyProgress(options, "Loading Z3DS tools...", 0);
      const azaharZ3ds = await _getAzaharZ3ds(options.threads);
      const workerCount = _getCompressionWorkerCount(azaharZ3ds, options.threads);
      options.onProgress?.(
        createNormalizedProgressEvent("Compressing to Z3DS...", 0, {
          aliases: ["Compressing to Z3DS"],
          sourceDisplayFileName: normalizedSource.sourceDisplayFileName,
        }),
      );
      await _yieldProgress();
      if (!(options.outputPath && typeof azaharZ3ds.compressPath === "function"))
        throw new Error("Path-backed Z3DS compression requires a filesystem-enabled Azahar Z3DS build");
      const inputSize = _getPathSize(azaharZ3ds, options.inputPath, normalizedSource.fileSize);
      const emitCompressionPercent = _createProgressEmitter(options, "Compressing to Z3DS...", normalizedSource, [
        "Compressing to Z3DS",
      ]);
      let readBytes = 0;
      try {
        _runPathOperationWithFsProgress({
          azaharZ3ds,
          onReadBytes: (bytes) => {
            if (inputSize === null) return;
            readBytes += bytes;
            emitCompressionPercent((readBytes / inputSize) * 100);
          },
          operation: () =>
            azaharZ3ds.compressPath?.(
              options.inputPath as string,
              options.outputPath as string,
              underlyingMagic,
              frameSize,
              metadata,
              workerCount,
              compressionLevel,
            ),
          readPath: options.inputPath,
        });
      } catch (error) {
        throw _normalizeZ3dsRuntimeError(azaharZ3ds, "compressing Z3DS", error);
      }
      _notifyProgress(options, "Done", 100);
      return _decorateCompressedPatchFile(
        _createPathOutputInfo(outputName, normalizedSource, options.outputPath),
        sourceFileName,
        outputName,
        underlyingMagic,
        metadata,
        options,
      );
    },

    decompress: async (source: Z3dsSourceInput, options?: Z3dsOptions) => {
      options = options || {};
      const normalizedSource = _normalizeSource(source, "input.z3ds");
      const sourceFileName = normalizedSource.fileName;
      _notifyProgress(options, "Loading Z3DS tools...", 0);
      const azaharZ3ds = await _getAzaharZ3ds(options.threads);
      let info: Z3dsInspectInfo | null | undefined;
      try {
        if (options.inputPath) {
          info = typeof azaharZ3ds.inspectPath === "function" ? azaharZ3ds.inspectPath(options.inputPath) : null;
        } else {
          info = azaharZ3ds.inspect(await _toUint8ArrayAsync(source));
        }
      } catch (error) {
        throw _normalizeZ3dsRuntimeError(azaharZ3ds, "inspecting Z3DS", error);
      }
      if (options.inputPath && !info)
        throw new Error("Path-backed Z3DS inspection requires a filesystem-enabled Azahar Z3DS build");
      if (!info?.isCompressed) throw new Error("Input is not a valid Z3DS file");
      info.underlyingMagic = _normalizeUnderlyingMagic(info.underlyingMagic || "");
      const outputName = options.outputName || manager.getExtractedFileName(source, info);
      const workerCount = _getDecompressionWorkerCount(azaharZ3ds, options.threads);
      options.onProgress?.(
        createNormalizedProgressEvent("Extracting Z3DS...", 0, {
          aliases: ["Extracting Z3DS"],
          sourceDisplayFileName: normalizedSource.sourceDisplayFileName,
        }),
      );
      await _yieldProgress();
      if (options.inputPath) {
        if (!(options.outputPath && typeof azaharZ3ds.decompressPath === "function"))
          throw new Error("Path-backed Z3DS extraction requires a filesystem-enabled Azahar Z3DS build");
        const extractedSize =
          _toPositiveNumber(info?.uncompressedSize) || _getPathSize(azaharZ3ds, options.outputPath, null);
        const compressedSize =
          _toPositiveNumber(info?.compressedSize) ||
          _getPathSize(azaharZ3ds, options.inputPath, normalizedSource.fileSize);
        const emitExtractionPercent = _createProgressEmitter(options, "Extracting Z3DS...", normalizedSource, [
          "Extracting Z3DS",
        ]);
        let readBytes = 0;
        let writtenBytes = 0;
        try {
          _runPathOperationWithFsProgress({
            azaharZ3ds,
            onReadBytes: (bytes) => {
              if (compressedSize === null || extractedSize !== null) return;
              readBytes += bytes;
              emitExtractionPercent((readBytes / compressedSize) * 100);
            },
            onWriteBytes: (bytes) => {
              if (extractedSize === null) return;
              writtenBytes += bytes;
              emitExtractionPercent((writtenBytes / extractedSize) * 100);
            },
            operation: () =>
              azaharZ3ds.decompressPath?.(options.inputPath as string, options.outputPath as string, workerCount),
            readPath: options.inputPath,
            writePath: options.outputPath,
          });
        } catch (error) {
          throw _normalizeZ3dsRuntimeError(azaharZ3ds, "extracting Z3DS", error);
        }
        _notifyProgress(options, "Done", 100);
        return _decorateDecompressedPatchFile(
          _createPathOutputInfo(outputName, normalizedSource, options.outputPath),
          sourceFileName,
          outputName,
          info,
          options,
        );
      }
      const input = await _toUint8ArrayAsync(source);
      const binFile = _createOutputPatchFile(azaharZ3ds, "extracting Z3DS", outputName, normalizedSource, () =>
        azaharZ3ds.decompress(input, workerCount),
      );
      _notifyProgress(options, "Done", 100);
      return _decorateDecompressedPatchFile(binFile, sourceFileName, outputName, info, options);
    },

    getCompressedFileName: (source: Z3dsSourceInput, options?: Z3dsOptions) => {
      const fileName = _getFileName(source);
      const extension = options?.compressedExtension || _getCompressedExtensionForSource(source);
      return _replaceExtension(fileName, extension);
    },

    getExtractedFileName: (source: Z3dsSourceInput, info?: Z3dsInspectInfo | null) => {
      const fileName = _getFileName(source);
      const extension = _getExtension(source);
      const rawExtension = _getRawExtensionFromInspectInfo(info, extension);
      return _replaceExtension(fileName, rawExtension);
    },

    getFormatLabel: (source: Z3dsSourceInput, info?: Z3dsInspectInfo | null) => {
      const rawExtension = _getRawExtensionFromInspectInfo(info || {}, _getExtension(source));
      if (rawExtension === "cia") return "CIA (Z)";
      if (rawExtension === "cci") return "CCI (Z)";
      if (rawExtension === "cxi" || rawExtension === "app") return "CXI (Z)";
      if (rawExtension === "3dsx") return "3DSX (Z)";
      if (rawExtension === "3ds") return "3DS (Z)";
      let underlyingMagic = _cleanUnderlyingMagic(info?.underlyingMagic || "");
      if (!underlyingMagic && rawExtension !== "bin")
        underlyingMagic = _cleanUnderlyingMagic(
          _getUnderlyingMagicForSource({ fileName: `input.${rawExtension}` }, rawExtension),
        );
      if (underlyingMagic === "CIA") return "CIA (Z)";
      if (underlyingMagic === "NCSD") return "CCI (Z)";
      if (underlyingMagic === "NCCH") return "CXI (Z)";
      if (underlyingMagic === "3DSX") return "3DSX (Z)";
      return "Z3DS";
    },

    getUnderlyingMagicForSource: (source: Z3dsSourceInput, fallbackExtension?: string) =>
      _getUnderlyingMagicForSource(source, fallbackExtension),

    inspect: async (source: Z3dsSourceInput) => {
      const azaharZ3ds = await _getAzaharZ3ds();
      const info = azaharZ3ds.inspect(await _toUint8ArrayAsync(source));
      if (!info?.isCompressed) return info || { isCompressed: false };
      info.underlyingMagic = _normalizeUnderlyingMagic(info.underlyingMagic || "");
      info.recommendedExtension = _getRawExtensionFromInspectInfo(info, _getExtension(source));
      info.recommendedFileName = manager.getExtractedFileName(source, info);
      return info;
    },
    isZ3dsFile: (source: Z3dsSourceInput) => {
      const extension = _getExtension(source);
      if (RAW_EXTENSION_BY_COMPRESSED_EXTENSION[extension as keyof typeof RAW_EXTENSION_BY_COMPRESSED_EXTENSION])
        return true;
      if (!_hasReadableBytes(source)) return false;
      if (_hasZ3dsMagic(source)) return true;
      return false;
    },

    toArrayBuffer: _toArrayBuffer,
  };

  return manager;
})(root, PatchFile, loadAzaharZ3ds) as Z3dsManagerApi;

export default Z3dsManager;
