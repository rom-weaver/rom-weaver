const XDELTA_PATH_BACKED_INPUT_ERROR = "xdelta3 requires path-backed input files";
const XDELTA_OPFS_STAGING_ERROR = "xdelta3 path-backed input staging requires an OPFS-backed worker filesystem";
const XDELTA_DIRECT_OUTPUT_REQUIRED_ERROR =
  "xdelta3 requires filesystem-backed direct output when an OPFS output manager is provided";
const XDELTA_MESSAGE_PREFIX_REGEX = /^xdelta3:\s*/i;
const XDELTA_CHECKSUM_ERROR_REGEX =
  /XD3_INVALID_INPUT|target window checksum|source.*checksum|checksum.*source|source.*mismatch|not a VCDIFF input|file open failed|target window does not match/i;
const XDELTA_COPY_CHUNK_SIZE = 8 * 1024 * 1024;

/*
 * XdeltaManager.js
 * Shared xdelta3 apply helper for RomWeaver.
 *
 * Uses xdelta3 compiled to WebAssembly. Input files are staged into the
 * module filesystem before invoking xdelta.
 */

import PatchFile from "../../../shared/file-io/patch-file.ts";
import {
  createNormalizedProgressEvent,
  createWasmToolError,
  normalizeWasmToolSource,
} from "../../../shared/wasm-tool-runtime-utils.ts";
import type { WorkerOpfsManager } from "../../../shared/worker-storage/types.ts";
import { assertNotXdeltaBrowserMainThread } from "./xdelta-runtime.ts";
import xdelta3Loader from "./xdelta3-loader.ts";

type RuntimeRoot = typeof globalThis & {
  PatchFile?: PatchFileConstructor;
  document?: object;
  navigator?: Navigator;
  window?: object;
};

type PatchFileReadable = {
  fileName?: string;
  filePath?: string;
  name?: string;
  fileSize: number;
  _file?: Blob;
  _u8array?: Uint8Array;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number;
  readBytesAt: (offset: number, len: number) => Uint8Array | ArrayBuffer | ArrayBufferView | number[];
};

type PatchFileWritable = {
  fileName?: string;
  fileType?: string;
  fileSize: number;
  _u8array?: Uint8Array;
  filePath?: string;
  backend?: { closed?: boolean; size?: number; accessHandle?: { close?: () => void; flush?: () => void } };
  writeBytesAt?: (offset: number, bytes: Uint8Array) => void;
  flush?: () => void;
  reset?: (size: number, fileName?: string, fileType?: string) => void;
  syncExternalWrite?: (size: number) => void;
};

type PatchFileSource = ArrayBuffer | Uint8Array;
type PatchFileInstance = PatchFileReadable & PatchFileWritable;
type PatchFileConstructor = new (source: PatchFileSource) => PatchFileInstance;

type XdeltaPatchFile = {
  isXdeltaPatch?: boolean;
  file?: PatchFileReadable;
  _originalPatchFile?: PatchFileReadable;
};

type ProgressEvent = {
  label: string;
  percent: number | null;
};

type SharedOptions = {
  onProgress?: (progress: ProgressEvent) => void;
};

type OpfsManager = Pick<
  WorkerOpfsManager,
  "ensureMounted" | "ensureNode" | "linkFile" | "openFile" | "outputDirectory" | "prepareFile" | "releaseFile"
> &
  Pick<WorkerOpfsManager, "usesPortableMount">;

type ApplyOptions = SharedOptions & {
  outputFileFactory?: (size: number) => PatchFileWritable;
  opfsManager?: OpfsManager;
  workerThreads?: number | string | null;
};

type CreateOptions = SharedOptions & {
  outputFileFactory?: (size: number) => PatchFileWritable;
  opfsManager?: OpfsManager;
  workerThreads?: number | string | null;
};

type XdeltaOperationOptions = {
  onProgress?: (progress: ProgressEvent) => void;
  workerThreads?: number | string | null;
};

type FileInfo = {
  name: string;
  size: number | null;
};

type XdeltaErrorContext = {
  source: FileInfo;
  patch?: FileInfo | null;
  target?: FileInfo | null;
  threaded: boolean;
  selectionReason: string;
  abortInfo?: RuntimeValue | null;
};

type XdeltaErrorDetailRole = {
  key: "patch" | "source" | "target";
  label: string;
};

type XdeltaError = Error & {
  wasmTool?: RuntimeValue;
  xdelta?: {
    status: number;
    stdout: string[];
    stderr: string[];
    source: FileInfo | null;
    patch: FileInfo | null;
    target?: FileInfo | null;
    threaded: boolean;
    selectionReason: string;
  };
  cause?: RuntimeValue;
};

type XdeltaModuleArg = {
  noInitialRun: boolean;
  print?: (text: RuntimeValue) => void;
  printErr?: (text: RuntimeValue) => void;
  workerThreads?: number | string | null;
  __xdeltaStdout?: string[];
  __xdeltaStderr?: string[];
};

type XdeltaRunOutput = {
  stdout: string[];
  stderr: string[];
};

type EmscriptenFs = {
  ErrnoError: new (errno: number) => Error;
  analyzePath: (path: string) => { exists: boolean };
  close?: (stream: RuntimeValue) => void;
  unlink: (path: string) => void;
  mkdirTree: (path: string) => void;
  open?: (path: string, flags: string) => RuntimeValue;
  write?: (stream: RuntimeValue, buffer: Uint8Array, offset: number, length: number, position?: number) => number;
  stat: (path: string) => { size: number };
  readFile: (path: string) => Uint8Array;
  writeFile: (path: string, bytes: Uint8Array) => void;
};

type XdeltaModule = {
  FS: EmscriptenFs;
  OPFS?: object;
  callMain: (args: string[]) => number;
  __romWeaverWasmAbort?: RuntimeValue | null;
  __xdeltaStdout?: string[];
  __xdeltaStderr?: string[];
  __xdeltaRunOutput?: XdeltaRunOutput;
  __xdelta3Threaded?: boolean;
  __xdelta3SelectionReason?: string;
};

type XdeltaLoader = (moduleArg: XdeltaModuleArg) => Promise<XdeltaModule>;

type DirectOutput = {
  outputFile: PatchFileWritable;
  outputPath?: string;
  direct: boolean;
};

type XdeltaMainRunResult = {
  caughtError: RuntimeValue;
  directOutput: DirectOutput | null;
  outputPath: string;
  status: number;
};

type XdeltaPreparedOutput = {
  directOutput: DirectOutput | null;
  outputPath: string;
};

type XdeltaRunConfig = {
  buildArgs: (inputPaths: Record<string, string>, outputPath: string) => string[];
  detailRoles: XdeltaErrorDetailRole[];
  errorContext: XdeltaErrorContext;
  fallbackFileName: string;
  files: Record<string, PatchFileReadable>;
  finalizingPhase: string;
  inputMountPoint: string;
  memoryOutputPath: string;
  operationPhase: string;
  options: ApplyOptions | CreateOptions;
  transformDiagnostics?: (message: string) => string;
};

type XdeltaManagerType = {
  applyPatch: (
    sourceFile: PatchFileReadable,
    patchFile: PatchFileReadable | XdeltaPatchFile,
    options?: ApplyOptions,
  ) => Promise<PatchFileInstance | PatchFileWritable>;
  createPatch: (
    sourceFile: PatchFileReadable,
    targetFile: PatchFileReadable,
    options?: CreateOptions,
  ) => Promise<PatchFileWritable>;
  getModule: (options?: XdeltaOperationOptions | null) => Promise<XdeltaModule>;
};

const root: RuntimeRoot = typeof globalThis === "undefined" ? (self as RuntimeRoot) : (globalThis as RuntimeRoot);
const XdeltaManager = ((runtimeRoot: RuntimeRoot) => {
  let xdelta3Promise: Promise<XdeltaModule> | null = null;
  let xdeltaRunPromise: Promise<RuntimeValue> = Promise.resolve();
  let workId = 0;

  const _assertNotBrowserMainThread = () => {
    assertNotXdeltaBrowserMainThread(runtimeRoot);
  };

  const _isMountedSourcePath = (manager: OpfsManager, filePath: string) => {
    const outputDirectory = String(manager.outputDirectory || "").replace(/\/+$/g, "");
    return !!(outputDirectory && (filePath === outputDirectory || filePath.startsWith(`${outputDirectory}/`)));
  };

  const _getXdeltaLoader = (): Promise<XdeltaLoader> => Promise.resolve(xdelta3Loader as unknown as XdeltaLoader);

  const _appendOutput = (target: string[], text: RuntimeValue) => {
    if (text === undefined || text === null) return;
    target.push(String(text));
  };

  const _getXdelta3 = (): Promise<XdeltaModule> => {
    _assertNotBrowserMainThread();
    if (xdelta3Promise) return xdelta3Promise;

    const moduleArg: XdeltaModuleArg = {
      noInitialRun: true,
    };
    moduleArg.print = (text) => {
      let stdout = moduleArg.__xdeltaStdout;
      if (!stdout) {
        stdout = [];
        moduleArg.__xdeltaStdout = stdout;
      }
      _appendOutput(stdout, text);
    };
    moduleArg.printErr = (text) => {
      let stderr = moduleArg.__xdeltaStderr;
      if (!stderr) {
        stderr = [];
        moduleArg.__xdeltaStderr = stderr;
      }
      _appendOutput(stderr, text);
    };

    xdelta3Promise = _getXdeltaLoader().then((loader) =>
      loader(moduleArg).then((moduleObject) => {
        moduleObject.__xdeltaStdout = moduleArg.__xdeltaStdout || [];
        moduleObject.__xdeltaStderr = moduleArg.__xdeltaStderr || [];
        moduleObject.__xdeltaRunOutput = {
          stderr: moduleObject.__xdeltaStderr,
          stdout: moduleObject.__xdeltaStdout,
        };
        return moduleObject;
      }),
    );
    return xdelta3Promise;
  };

  const _withRunLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const runPromise = xdeltaRunPromise.then(fn, fn);
    xdeltaRunPromise = runPromise.catch(() => undefined);
    return runPromise;
  };

  const _getPatchFile = (patchFile: PatchFileReadable | XdeltaPatchFile): PatchFileReadable => {
    if ("isXdeltaPatch" in patchFile && patchFile.isXdeltaPatch && patchFile.file) return patchFile.file;
    if ("isXdeltaPatch" in patchFile && patchFile.isXdeltaPatch && patchFile._originalPatchFile)
      return patchFile._originalPatchFile;
    return patchFile as PatchFileReadable;
  };

  const _isReadableFile = (file: RuntimeValue): file is PatchFileReadable =>
    !!file &&
    typeof file === "object" &&
    typeof (file as PatchFileReadable).fileSize === "number" &&
    typeof (file as PatchFileReadable).readBytesAt === "function";

  const _getPathBackedInputPath = (fileName: string, sourceFile: PatchFileReadable) => {
    const sourcePath = typeof sourceFile.filePath === "string" ? sourceFile.filePath.trim() : "";
    if (!sourcePath) throw new Error(`${XDELTA_PATH_BACKED_INPUT_ERROR}: ${fileName}`);
    return sourcePath;
  };

  const _assertPathBackedInputFiles = (files: Record<string, PatchFileReadable>) => {
    for (const [fileName, sourceFile] of Object.entries(files)) _getPathBackedInputPath(fileName, sourceFile);
  };

  const _requireReadableFile = (file: RuntimeValue, label: string): PatchFileReadable => {
    if (!_isReadableFile(file)) throw new Error(`${label} file is not PatchFile-compatible`);
    return file;
  };

  const _getSourceDisplayFileName = (
    sourceFile: PatchFileReadable,
    pathBackedFiles: Record<string, PatchFileReadable>,
  ): string => {
    _assertPathBackedInputFiles(pathBackedFiles);
    return normalizeWasmToolSource(sourceFile, {
      fallbackFileName: "source.bin",
      fileNameKeys: ["fileName", "name"],
    }).sourceDisplayFileName;
  };

  const _asMountedFsModule = (moduleObject: XdeltaModule) =>
    moduleObject as unknown as Parameters<OpfsManager["ensureMounted"]>[0];

  const _safeRemove = (FS: EmscriptenFs, path: string) => {
    try {
      if (FS.analyzePath(path).exists) FS.unlink(path);
    } catch (_err) {
      /* ignore cleanup errors */
    }
  };

  const _ensureDirectory = (FS: EmscriptenFs, directory: string) => {
    try {
      FS.mkdirTree(directory);
    } catch (_err) {
      /* ignore cleanup errors */
    }
  };

  const _getErrorMessage = (err: RuntimeValue) => {
    if (!err) return "";
    if (err instanceof Error && typeof err.message === "string" && err.message.trim()) return err.message.trim();
    const message = String(err);
    return message === "[object Object]" ? "" : message;
  };

  const _normalizeDiagnosticLines = (lines: string[]) =>
    (lines || [])
      .map((line) =>
        String(line || "")
          .replace(/\r/g, "")
          .replace(XDELTA_MESSAGE_PREFIX_REGEX, "")
          .trim(),
      )
      .filter(Boolean);

  const _formatDiagnostics = (stdout: string[], stderr: string[], caughtError: RuntimeValue) => {
    const diagnostics = _normalizeDiagnosticLines(stderr).concat(_normalizeDiagnosticLines(stdout));
    const caughtMessage = _getErrorMessage(caughtError);
    if (!diagnostics.length && caughtMessage) diagnostics.push(caughtMessage);
    return diagnostics.join("; ").trim();
  };

  const _getFileInfo = (file: Partial<PatchFileReadable> | undefined, fallbackName: string): FileInfo => ({
    name: String(file?.fileName || file?.name || fallbackName || "file.bin"),
    size: typeof file?.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : null,
  });

  const _formatFileInfo = (label: string, fileInfo: FileInfo) =>
    `${label}: ${fileInfo.name}${typeof fileInfo.size === "number" ? ` (${fileInfo.size} bytes)` : ""}`;

  const _toUint8Array = (value: ArrayBuffer | Uint8Array | ArrayBufferView | number[]): Uint8Array => {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return Uint8Array.from(value);
  };

  const _readFileChunk = (file: PatchFileReadable, offset: number, len: number): Uint8Array => {
    if (typeof file.readIntoAt === "function") {
      const buffer = new Uint8Array(Math.max(0, len || 0));
      const bytesRead = file.readIntoAt(buffer, 0, buffer.byteLength, offset);
      return bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, Math.max(0, bytesRead || 0));
    }
    return _toUint8Array(file.readBytesAt(offset, len));
  };

  const _stageReadableFileToFs = (FS: EmscriptenFs, filePath: string, sourceFile: PatchFileReadable) => {
    if (typeof FS.open === "function" && typeof FS.write === "function" && typeof FS.close === "function") {
      const stream = FS.open(filePath, "w+");
      try {
        for (let offset = 0; offset < sourceFile.fileSize; offset += XDELTA_COPY_CHUNK_SIZE) {
          const chunkLength = Math.min(XDELTA_COPY_CHUNK_SIZE, sourceFile.fileSize - offset);
          const chunkBytes = _readFileChunk(sourceFile, offset, chunkLength);
          if (!chunkBytes.byteLength) break;
          FS.write(stream, chunkBytes, 0, chunkBytes.byteLength, offset);
        }
      } finally {
        FS.close(stream);
      }
      return;
    }

    const bytes = new Uint8Array(sourceFile.fileSize);
    for (let offset = 0; offset < sourceFile.fileSize; offset += XDELTA_COPY_CHUNK_SIZE) {
      const chunkLength = Math.min(XDELTA_COPY_CHUNK_SIZE, sourceFile.fileSize - offset);
      const chunkBytes = _readFileChunk(sourceFile, offset, chunkLength);
      bytes.set(chunkBytes, offset);
    }
    FS.writeFile(filePath, bytes);
  };

  const _materializeMemoryOutputToFactory = (
    outputFileFactory: NonNullable<ApplyOptions["outputFileFactory"] | CreateOptions["outputFileFactory"]>,
    memoryOutput: PatchFileInstance,
  ): PatchFileWritable => {
    const outputBytes = _readFileChunk(memoryOutput, 0, memoryOutput.fileSize);
    const outputFile = outputFileFactory(outputBytes.byteLength);
    if (typeof outputFile.writeBytesAt !== "function")
      throw new Error("xdelta3 output file factory must return a writable filesystem-backed file");
    outputFile.writeBytesAt(0, outputBytes);
    outputFile.fileSize = outputBytes.byteLength;
    if (!outputFile.fileName && memoryOutput.fileName) outputFile.fileName = memoryOutput.fileName;
    outputFile.flush?.();
    return outputFile;
  };

  const _attachWasmToolError = (
    error: XdeltaError,
    status: number,
    stdout: string[],
    stderr: string[],
    caughtError: RuntimeValue,
    context: {
      threaded: boolean;
      selectionReason: string;
      abortInfo?: RuntimeValue | null;
    },
    phase: string,
  ) => {
    const wasmError = createWasmToolError({
      argv: [phase],
      cause: caughtError,
      fallbackMessage: "xdelta3 failed",
      phase,
      status,
      stderr: stderr.join("\n"),
      stdout: stdout.join("\n"),
      tool: {
        __romWeaverWasmAbort: context.abortInfo || null,
        selectionReason: context.selectionReason,
        threaded: context.threaded,
        wasmToolName: "xdelta3",
      } as RuntimeValue as Parameters<typeof createWasmToolError>[0]["tool"],
    });
    error.wasmTool = wasmError.wasmTool;
    return error;
  };

  const _createXdeltaErrorContext = (
    sourceFile: PatchFileReadable,
    moduleObject: XdeltaModule,
    relatedFiles: { patch?: PatchFileReadable; target?: PatchFileReadable },
  ): XdeltaErrorContext => ({
    abortInfo: moduleObject.__romWeaverWasmAbort || null,
    patch: relatedFiles.patch ? _getFileInfo(relatedFiles.patch, "patch.xdelta") : null,
    selectionReason: moduleObject.__xdelta3SelectionReason || "",
    source: _getFileInfo(sourceFile, "source.bin"),
    target: relatedFiles.target ? _getFileInfo(relatedFiles.target, "target.bin") : null,
    threaded: moduleObject.__xdelta3Threaded === true,
  });

  const _formatErrorDetails = (context: XdeltaErrorContext, detailRoles: XdeltaErrorDetailRole[]) => {
    const details: string[] = [];
    for (const detailRole of detailRoles) {
      const fileInfo = context[detailRole.key];
      if (fileInfo) details.push(_formatFileInfo(detailRole.label, fileInfo));
    }
    if (context.selectionReason)
      details.push(`WASM: ${context.threaded ? "threaded" : "single-threaded"} (${context.selectionReason})`);
    return details;
  };

  const _normalizePatchDiagnostics = (message: string) =>
    XDELTA_CHECKSUM_ERROR_REGEX.test(message) ? `invalid source file or patch/source mismatch. ${message}` : message;

  const _normalizeXdeltaError = (
    status: number,
    stdout: string[],
    stderr: string[],
    caughtError: RuntimeValue,
    context: XdeltaErrorContext,
    phase: string,
    detailRoles: XdeltaErrorDetailRole[],
    transformDiagnostics?: (message: string) => string,
  ): XdeltaError => {
    const diagnostics = _formatDiagnostics(stdout, stderr, caughtError);
    const statusText = typeof status === "number" && Number.isFinite(status) ? ` with status ${status}` : "";
    const defaultMessage = diagnostics || "no xdelta3 diagnostic output";
    const message = transformDiagnostics ? transformDiagnostics(defaultMessage) : defaultMessage;
    const details = _formatErrorDetails(context, detailRoles);

    const error = new Error(
      `xdelta3 failed${phase ? ` while ${phase}` : ""}${statusText}: ${message}${
        details.length ? `. ${details.join(". ")}` : ""
      }`,
    ) as XdeltaError;
    error.xdelta = {
      patch: context.patch || null,
      selectionReason: context.selectionReason || "",
      source: context.source || null,
      status,
      stderr: stderr.slice(),
      stdout: stdout.slice(),
      ...(context.target ? { target: context.target } : {}),
      threaded: context.threaded === true,
    };
    if (caughtError !== undefined) error.cause = caughtError;
    return _attachWasmToolError(error, status, stdout, stderr, caughtError, context, phase);
  };

  const _getDirectOutputFile = async (
    options: ApplyOptions | CreateOptions | undefined,
    moduleObject: XdeltaModule,
    directOutputMountPoint: string,
  ): Promise<DirectOutput | null> => {
    if (!options || typeof options.outputFileFactory !== "function" || !options.opfsManager) return null;

    const outputFile = options.outputFileFactory(0);
    if (!outputFile.filePath || typeof options.opfsManager.ensureMounted !== "function") return null;
    const mountedFilesystem = options.opfsManager.ensureMounted(_asMountedFsModule(moduleObject));
    if (
      mountedFilesystem &&
      typeof options.opfsManager.ensureNode === "function" &&
      !options.opfsManager.ensureNode(outputFile.filePath)
    )
      return null;
    if (!mountedFilesystem) return null;
    outputFile.flush?.();
    if (!options.opfsManager.usesPortableMount && moduleObject.OPFS) {
      try {
        outputFile.backend?.accessHandle?.close?.();
        if (outputFile.backend) outputFile.backend.closed = true;
      } catch (_error) {
        /* ignore output handle release errors */
      }
    }
    return {
      direct: true,
      outputFile,
      outputPath: outputFile.filePath,
    };
  };

  const _prepareXdeltaOutput = (
    moduleObject: XdeltaModule,
    options: ApplyOptions | CreateOptions,
    memoryOutputPath: string,
    directOutputMountPoint: string,
  ): Promise<XdeltaPreparedOutput> => {
    return _getDirectOutputFile(options, moduleObject, directOutputMountPoint).then((directOutput) => {
      if (!directOutput?.direct && typeof options.outputFileFactory === "function" && options.opfsManager)
        throw new Error(XDELTA_DIRECT_OUTPUT_REQUIRED_ERROR);
      return {
        directOutput,
        outputPath: directOutput?.outputPath || memoryOutputPath,
      };
    });
  };

  const _finalizeDirectOutput = (FS: EmscriptenFs, directOutput: DirectOutput): PatchFileWritable => {
    if (!directOutput.outputPath) return directOutput.outputFile;
    const outputFile = directOutput.outputFile;
    const stat = FS.stat(directOutput.outputPath);
    if (typeof outputFile.syncExternalWrite === "function") {
      outputFile.syncExternalWrite(stat.size);
      return outputFile;
    }
    outputFile.fileSize = stat.size;
    if (outputFile.backend) outputFile.backend.size = stat.size;
    if (typeof outputFile.backend?.accessHandle?.flush === "function") outputFile.backend.accessHandle.flush();
    else if (typeof outputFile.flush === "function") outputFile.flush();
    return outputFile;
  };

  const _finalizeMemoryOutput = (FS: EmscriptenFs, outputPath: string, fallbackFileName: string): PatchFileInstance => {
    const outputBytes = Uint8Array.from(FS.readFile(outputPath));
    const outputFile = new PatchFile(
      outputBytes.buffer.slice(outputBytes.byteOffset, outputBytes.byteOffset + outputBytes.byteLength),
    ) as PatchFileInstance;
    outputFile.fileName = fallbackFileName;
    return outputFile;
  };

  const _resetXdeltaRunOutput = (moduleObject: XdeltaModule): XdeltaRunOutput => {
    const output = { stderr: [], stdout: [] };
    moduleObject.__xdeltaStdout = output.stdout;
    moduleObject.__xdeltaStderr = output.stderr;
    moduleObject.__xdeltaRunOutput = output;
    return output;
  };

  const _runXdeltaMain = (
    moduleObject: XdeltaModule,
    preparedOutput: XdeltaPreparedOutput,
    buildArgs: (outputPath: string) => string[],
  ): XdeltaMainRunResult => {
    const { directOutput, outputPath } = preparedOutput;
    let caughtError: RuntimeValue = null;
    let status = 1;
    try {
      status = moduleObject.callMain(buildArgs(outputPath));
    } catch (err) {
      caughtError = err;
    }
    return { caughtError, directOutput, outputPath, status };
  };

  const _finishXdeltaRun = (
    FS: EmscriptenFs,
    config: XdeltaRunConfig,
    output: XdeltaRunOutput,
    runResult: XdeltaMainRunResult,
  ): PatchFileInstance | PatchFileWritable => {
    const { caughtError, directOutput, status } = runResult;
    if (status !== 0 || caughtError)
      throw _normalizeXdeltaError(
        status,
        output.stdout,
        output.stderr,
        caughtError,
        config.errorContext,
        config.operationPhase,
        config.detailRoles,
        config.transformDiagnostics,
      );

    try {
      if (directOutput?.direct) return _finalizeDirectOutput(FS, directOutput);
      if (typeof config.options.outputFileFactory === "function" && config.options.opfsManager)
        throw new Error(XDELTA_DIRECT_OUTPUT_REQUIRED_ERROR);
      const memoryOutput = _finalizeMemoryOutput(FS, config.memoryOutputPath, config.fallbackFileName);
      if (typeof config.options.outputFileFactory === "function")
        return _materializeMemoryOutputToFactory(config.options.outputFileFactory, memoryOutput);
      return memoryOutput;
    } catch (err) {
      throw _normalizeXdeltaError(
        status,
        output.stdout,
        output.stderr,
        err,
        config.errorContext,
        config.finalizingPhase,
        config.detailRoles,
        config.transformDiagnostics,
      );
    }
  };

  const _stageXdeltaInputFiles = async (
    moduleObject: XdeltaModule,
    config: XdeltaRunConfig,
  ): Promise<{ cleanupPaths: string[]; inputPaths: Record<string, string> }> => {
    const cleanupPaths: string[] = [];
    const inputPaths: Record<string, string> = {};
    const FS = moduleObject.FS;
    const opfsManager = config.options.opfsManager;
    if (!opfsManager) throw new Error(XDELTA_OPFS_STAGING_ERROR);
    const mountedWorkerFilesystem = opfsManager.ensureMounted(_asMountedFsModule(moduleObject));
    for (const [fileName, sourceFile] of Object.entries(config.files)) {
      const stagedPath = `${config.inputMountPoint}/${fileName}`;
      const sourcePath = _getPathBackedInputPath(fileName, sourceFile);
      if (mountedWorkerFilesystem) {
        const openedSource = await opfsManager.openFile?.(sourcePath);
        if (
          openedSource &&
          _isMountedSourcePath(opfsManager, sourcePath) &&
          opfsManager.ensureNode?.(sourcePath) !== false
        ) {
          inputPaths[fileName] = sourcePath;
          continue;
        }
        const preparedTarget = await opfsManager.prepareFile?.(stagedPath);
        if (openedSource && preparedTarget && opfsManager.linkFile?.(sourcePath, stagedPath)) {
          inputPaths[fileName] = stagedPath;
          cleanupPaths.push(stagedPath);
          continue;
        }
      }
      _stageReadableFileToFs(FS, stagedPath, sourceFile);
      inputPaths[fileName] = stagedPath;
      cleanupPaths.push(stagedPath);
    }
    return { cleanupPaths, inputPaths };
  };

  const _executeXdeltaRun = async (
    moduleObject: XdeltaModule,
    config: XdeltaRunConfig,
  ): Promise<PatchFileInstance | PatchFileWritable> => {
    const FS = moduleObject.FS;
    const output = _resetXdeltaRunOutput(moduleObject);
    _ensureDirectory(FS, config.inputMountPoint);
    _ensureDirectory(FS, "/xdelta-output");
    _safeRemove(FS, config.memoryOutputPath);
    const preparedOutput = await _prepareXdeltaOutput(
      moduleObject,
      config.options,
      config.memoryOutputPath,
      `${config.inputMountPoint}-direct`,
    );
    const stagedInputs = await _stageXdeltaInputFiles(moduleObject, config);

    const runResult = _runXdeltaMain(moduleObject, preparedOutput, (outputPath) =>
      config.buildArgs(stagedInputs.inputPaths, outputPath),
    );
    try {
      return _finishXdeltaRun(FS, config, output, runResult);
    } finally {
      for (const stagedPath of stagedInputs.cleanupPaths) {
        config.options.opfsManager?.releaseFile?.(stagedPath);
        _safeRemove(FS, stagedPath);
      }
      if (runResult.outputPath === config.memoryOutputPath) _safeRemove(FS, config.memoryOutputPath);
    }
  };

  const _applyPatchWithModule = (
    moduleObject: XdeltaModule,
    sourceFile: PatchFileReadable,
    patchFile: PatchFileReadable,
    options: ApplyOptions,
  ): Promise<PatchFileInstance | PatchFileWritable> => {
    const id = ++workId;
    const inputMountPoint = `/xdelta-input-${id}`;
    const memoryOutputPath = `/xdelta-output/patched-${id}.bin`;
    return _executeXdeltaRun(moduleObject, {
      buildArgs: (inputPaths, outputPath) => [
        "-d",
        "-f",
        "-s",
        inputPaths["source.bin"] || `${inputMountPoint}/source.bin`,
        inputPaths["patch.xdelta"] || `${inputMountPoint}/patch.xdelta`,
        outputPath,
      ],
      detailRoles: [
        { key: "source", label: "Source" },
        { key: "patch", label: "Patch" },
      ],
      errorContext: _createXdeltaErrorContext(sourceFile, moduleObject, {
        patch: patchFile,
      }),
      fallbackFileName: sourceFile.fileName || "patched.bin",
      files: {
        "patch.xdelta": patchFile,
        "source.bin": sourceFile,
      },
      finalizingPhase: "finalizing output",
      inputMountPoint,
      memoryOutputPath,
      operationPhase: "applying patch",
      options,
      transformDiagnostics: _normalizePatchDiagnostics,
    });
  };

  const _createPatchWithModule = (
    moduleObject: XdeltaModule,
    sourceFile: PatchFileReadable,
    targetFile: PatchFileReadable,
    options: CreateOptions,
  ): Promise<PatchFileWritable> => {
    const id = ++workId;
    const inputMountPoint = `/xdelta-create-input-${id}`;
    const memoryOutputPath = `/xdelta-output/patch-${id}.xdelta`;
    return _executeXdeltaRun(moduleObject, {
      buildArgs: (inputPaths, outputPath) => [
        "-e",
        "-f",
        "-s",
        inputPaths["source.bin"] || `${inputMountPoint}/source.bin`,
        inputPaths["target.bin"] || `${inputMountPoint}/target.bin`,
        outputPath,
      ],
      detailRoles: [
        { key: "source", label: "Source" },
        { key: "target", label: "Modified" },
      ],
      errorContext: _createXdeltaErrorContext(sourceFile, moduleObject, {
        target: targetFile,
      }),
      fallbackFileName: targetFile.fileName || "patch.xdelta",
      files: {
        "source.bin": sourceFile,
        "target.bin": targetFile,
      },
      finalizingPhase: "finalizing patch",
      inputMountPoint,
      memoryOutputPath,
      operationPhase: "creating patch",
      options,
    }) as Promise<PatchFileWritable>;
  };

  const _runXdeltaOperation = <T>(
    options: XdeltaOperationOptions | undefined,
    progressLabel: string,
    runWithModule: (moduleObject: XdeltaModule) => Promise<T> | T,
    sourceDisplayFileName?: string,
  ): Promise<T> =>
    _withRunLock(() => {
      if (options && typeof options.onProgress === "function") {
        options.onProgress(
          createNormalizedProgressEvent("Loading xdelta3...", 0, {
            aliases: ["Loading xdelta3..."],
            sourceDisplayFileName,
          }),
        );
      }
      return _getXdelta3().then(async (moduleObject) => {
        if (options && typeof options.onProgress === "function") {
          options.onProgress(
            createNormalizedProgressEvent(progressLabel, null, {
              aliases: [progressLabel],
              sourceDisplayFileName,
            }),
          );
        }
        const outputFile = await runWithModule(moduleObject);
        if (options && typeof options.onProgress === "function") {
          options.onProgress(
            createNormalizedProgressEvent("Done", 100, {
              aliases: ["Done"],
              sourceDisplayFileName,
            }),
          );
        }
        return outputFile;
      });
    });

  const manager: XdeltaManagerType = {
    applyPatch: (sourceFile, patchFile, options) => {
      _assertNotBrowserMainThread();
      let resolvedPatchFile: PatchFileReadable;
      let sourceDisplayFileName: string;
      try {
        const readableSourceFile = _requireReadableFile(sourceFile, "Source");
        resolvedPatchFile = _requireReadableFile(_getPatchFile(patchFile), "Patch");
        sourceDisplayFileName = _getSourceDisplayFileName(readableSourceFile, {
          "patch.xdelta": resolvedPatchFile,
          "source.bin": readableSourceFile,
        });
      } catch (error) {
        return Promise.reject(error);
      }

      return _runXdeltaOperation(
        options,
        "Applying xdelta patch...",
        (moduleObject) => _applyPatchWithModule(moduleObject, sourceFile, resolvedPatchFile, options || {}),
        sourceDisplayFileName,
      );
    },
    createPatch: (sourceFile, targetFile, options) => {
      _assertNotBrowserMainThread();
      let readableTargetFile: PatchFileReadable;
      let sourceDisplayFileName: string;
      try {
        const readableSourceFile = _requireReadableFile(sourceFile, "Source");
        readableTargetFile = _requireReadableFile(targetFile, "Modified");
        sourceDisplayFileName = _getSourceDisplayFileName(readableSourceFile, {
          "source.bin": readableSourceFile,
          "target.bin": readableTargetFile,
        });
      } catch (error) {
        return Promise.reject(error);
      }

      return _runXdeltaOperation(
        options,
        "Creating xdelta patch...",
        (moduleObject) => _createPatchWithModule(moduleObject, sourceFile, readableTargetFile, options || {}),
        sourceDisplayFileName,
      );
    },
    getModule: _getXdelta3,
  };

  return manager;
})(root);

export default XdeltaManager;
