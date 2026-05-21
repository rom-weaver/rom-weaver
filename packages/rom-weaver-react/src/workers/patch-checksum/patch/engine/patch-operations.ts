import { APS, APSGBA, BDF, BPS, IPS, PMSR, PPF, RUP, UPS, VCDIFF } from "../../../protocol/patch-formats.ts";
import type {
  CoreRomPatchFileLike,
  OutputFileFactory,
  ParsedPatchLike,
  ParsedPatchWithSourceLike,
  PatchFileLike,
  ProgressEventLike,
} from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import XdeltaManager from "../xdelta/XdeltaManager.ts";
import {
  createPatchSequenceProgress as _createPatchSequenceProgress,
  generatePatchedFileName as _generatePatchedFileName,
  getOutputFileNameFromOptions as _getOutputFileNameFromOptions,
  getPatchedSuffixFileName as _getPatchedSuffixFileName,
  normalizeApplyPatchOptions as _normalizeApplyPatchOptions,
  type ApplyOptionRecord,
  type ApplyPatchOptions,
  type ProgressInput,
} from "./patch-engine-helpers.ts";

const SEGA_GENESIS_HEADER_REGEX = /SEGA (GENESIS|MEGA DR)/;
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | Blob
  | ArrayBufferLike
  | Uint8Array;
type JsonRecord = {
  [key: string]: JsonValue;
};

/*
 * RomWeaver core
 * A ROM patcher/builder made in JavaScript, can be implemented as a webapp or a Node.JS CLI tool
 * By Marc Robledo https://www.marcrobledo.com
 * Sourcecode: https://github.com/marcrobledo/PatchEngine.js
 * License:
 *
 * MIT License
 *
 * Copyright (c) 2016-2025 Marc Robledo
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const PatchEngine = (() => {
  const TOO_BIG_ROM_SIZE = 67108863;
  type HeaderInfo = {
    extensions: string[];
    size: number;
    romSizeMultiple: number;
    name: string;
  };
  type PreparedRomResult = {
    romFile: CoreRomPatchFileLike;
    extractedHeader: CoreRomPatchFileLike | false;
    fakeHeaderSize: number;
  };
  type PatchSequenceContext = {
    originalRomFileName: string;
    originalRomFileType: string;
    romFile: CoreRomPatchFileLike;
    preparedRom: PreparedRomResult;
  };
  type MutablePatchedRom = CoreRomPatchFileLike & {
    unpatched?: boolean;
    fakeHeader?: boolean;
  };
  type OpfsManagerLike = {
    outputDirectory?: string;
    cleanup?: (filePaths?: string[]) => Promise<void>;
  };
  type PatchMetadata = {
    Description?: string;
    [key: string]: JsonRecord[keyof JsonRecord] | undefined;
  };
  type PatchParserInput = CoreRomPatchFileLike;
  type ParsedPatchResult = ParsedPatchWithSourceLike | ParsedPatchLike | null;
  type XdeltaManagerLike = {
    applyPatch: (
      sourceFile: CoreRomPatchFileLike,
      patchFile: XdeltaPatchFileSource,
      options?: object,
    ) => Promise<CoreRomPatchFileLike | PatchFileLike>;
    createPatch: (
      sourceFile: CoreRomPatchFileLike,
      targetFile: CoreRomPatchFileLike,
      options?: {
        outputFileFactory?: ((size: number) => RuntimeValue) | null;
        opfsManager?: OpfsManagerLike | null;
        workerThreads?: string | number | null;
      },
    ) => Promise<CoreRomPatchFileLike>;
  };
  type XdeltaApplyInput = Parameters<XdeltaManagerLike["applyPatch"]>[0];
  type XdeltaCreateInput = Parameters<XdeltaManagerLike["createPatch"]>[0];
  type IpsPatchFileInput = Parameters<typeof IPS.fromFile>[0];
  type UpsPatchFileInput = Parameters<typeof UPS.fromFileAsync>[0];
  type ApsPatchFileInput = Parameters<typeof APS.fromFile>[0];
  type ApsGbaPatchFileInput = Parameters<typeof APSGBA.fromFile>[0];
  type BpsPatchFileInput = Parameters<typeof BPS.fromFileAsync>[0];
  type RupPatchFileInput = Parameters<typeof RUP.fromFile>[0];
  type PpfPatchFileInput = Parameters<typeof PPF.fromFile>[0];
  type BdfPatchFileInput = Parameters<typeof BDF.fromFile>[0];
  type PmsrPatchFileInput = Parameters<typeof PMSR.fromFile>[0];
  type VcdiffPatchFileInput = Parameters<typeof VCDIFF.fromFile>[0];
  type BpsBuildInput = Parameters<typeof BPS.buildFromRomsAsync>[0];
  type UpsBuildInput = Parameters<typeof UPS.buildFromRomsAsync>[0];
  type RupBuildInput = Parameters<typeof RUP.buildFromRomsAsync>[0];
  type IpsBuildInput = Parameters<typeof IPS.buildFromRoms>[0];
  type PpfBuildInput = Parameters<typeof PPF.buildFromRoms>[0];
  type ApsBuildInput = Parameters<typeof APS.buildFromRoms>[0];
  type RomWithBrowserBackingFlag = CoreRomPatchFileLike & {
    _browserFileBacked?: boolean;
  };
  type CreatePatchFormat = "ips" | "bps" | "ppf" | "ups" | "aps" | "rup" | "ebp" | "xdelta" | "vcdiff";
  type SyncPatchBuilderWithMetadata = (
    originalFile: CoreRomPatchFileLike,
    modifiedFile: CoreRomPatchFileLike,
    metadata: PatchMetadata | null | undefined,
  ) => ParsedPatchLike;
  const HEADERS_INFO: HeaderInfo[] = [
    {
      extensions: ["nes"],
      name: "iNES",
      romSizeMultiple: 1024,
      size: 16,
    } /* https://www.nesdev.org/wiki/INES */,
    {
      extensions: ["fds"],
      name: "fwNES",
      romSizeMultiple: 65500,
      size: 16,
    } /* https://www.nesdev.org/wiki/FDS_file_format */,
    { extensions: ["lnx"], name: "LNX", romSizeMultiple: 1024, size: 64 },
    {
      extensions: ["sfc", "smc", "swc", "fig"],
      name: "SNES copier",
      romSizeMultiple: 262144,
      size: 512,
    },
  ];

  const GAME_BOY_NINTENDO_LOGO = [
    0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11,
    0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  ];

  const _isXdeltaPatch = (patch: ParsedPatchLike) =>
    !!(patch && (patch as ParsedPatchWithSourceLike).isXdeltaPatch === true);
  const _isXdeltaCreateFormat = (format: string | null | undefined) => format === "xdelta" || format === "vcdiff";
  const _shouldApplyWithXdeltaManager = (patch: ParsedPatchLike) => _isXdeltaPatch(patch);
  type ReadablePatchPatchFile = PatchFileLike & {
    readBytesAt: NonNullable<PatchFileLike["readBytesAt"]>;
  };
  type XdeltaPatchFileSource =
    | ReadablePatchPatchFile
    | {
        file?: ReadablePatchPatchFile;
        _originalPatchFile?: ReadablePatchPatchFile;
      };
  const _isReadablePatchPatchFile = (
    value: PatchFileLike | ParsedPatchWithSourceLike | null | undefined,
  ): value is ReadablePatchPatchFile => !!value && typeof (value as PatchFileLike).readBytesAt === "function";
  const _getXdeltaPatchFile = (patch: ParsedPatchWithSourceLike): XdeltaPatchFileSource => {
    if (_isReadablePatchPatchFile(patch?._originalPatchFile)) return patch._originalPatchFile;
    if (_isReadablePatchPatchFile(patch?.file)) return patch.file;
    if (_isReadablePatchPatchFile(patch)) return patch;
    throw new Error("Xdelta patch source is not readable");
  };
  const _hasPathBackedXdeltaPatchSource = (patch: ParsedPatchLike) => {
    if (!_isXdeltaPatch(patch)) return false;
    try {
      const patchFile = _getXdeltaPatchFile(patch as ParsedPatchWithSourceLike) as ReadablePatchPatchFile;
      return typeof patchFile.filePath === "string" && !!patchFile.filePath.trim();
    } catch (_error) {
      return false;
    }
  };
  let xdeltaManager: XdeltaManagerLike | null = XdeltaManager as unknown as XdeltaManagerLike;
  const _getXdeltaManager = () => {
    if (xdeltaManager && typeof xdeltaManager.applyPatch === "function") return xdeltaManager;
    throw new Error("XdeltaManager must be configured by a worker runtime to apply VCDIFF/xdelta patches");
  };
  const _validatePatchList = (patches: ParsedPatchLike | ParsedPatchLike[]): ParsedPatchLike[] => {
    if (!Array.isArray(patches)) patches = [patches];
    if (!patches.length) throw new Error("No patch file provided");
    for (const item of patches) {
      if (typeof item !== "object") throw new Error("Unknown patch format");
    }
    return patches;
  };
  const _copyFileIdentity = <TFile extends CoreRomPatchFileLike>(
    targetFile: TFile,
    sourceFile: PatchFileLike,
  ): TFile => {
    targetFile.fileName = sourceFile.fileName;
    targetFile.fileType = sourceFile.fileType;
    return targetFile;
  };
  const _createFileWithPrependedHeader = (
    headerFile: CoreRomPatchFileLike,
    romFile: CoreRomPatchFileLike,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
  ) => {
    const nextFile = createOutputFile(headerFile.fileSize + romFile.fileSize);
    _copyFileIdentity(nextFile, romFile);
    headerFile.copyTo(nextFile, 0, headerFile.fileSize);
    romFile.copyTo(nextFile, 0, romFile.fileSize, headerFile.fileSize);
    return nextFile;
  };
  const _createRomWithFakeHeader = (
    romFile: CoreRomPatchFileLike,
    headerSize: number,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
  ) => {
    const romWithFakeHeader = createOutputFile(headerSize + romFile.fileSize);
    _copyFileIdentity(romWithFakeHeader, romFile);
    romFile.copyTo(romWithFakeHeader, 0, romFile.fileSize, headerSize);
    if (_getRomSystem(romWithFakeHeader) === "fds") {
      const writableRomWithFakeHeader = romWithFakeHeader as MutablePatchedRom & {
        writeBytes: (bytes: number[]) => void;
      };
      writableRomWithFakeHeader.seek(0);
      writableRomWithFakeHeader.writeBytes([0x46, 0x44, 0x53, 0x1a, romFile.fileSize / 65500]);
    }
    romWithFakeHeader.fakeHeader = true;
    return romWithFakeHeader;
  };
  const _prepareRomForPatchSequence = (
    romFile: CoreRomPatchFileLike,
    options: ApplyPatchOptions,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
  ): PreparedRomResult => {
    let extractedHeader: CoreRomPatchFileLike | false = false;
    var fakeHeaderSize = 0;
    if (options.removeHeader) {
      const headerInfo = PatchEngine.isRomHeadered(romFile);
      if (headerInfo) {
        const splitData = PatchEngine.removeHeader(romFile);
        if (!splitData) throw new Error("Could not remove ROM header");
        extractedHeader = splitData.header;
        romFile = splitData.rom;
      }
    } else if (options.addHeader) {
      const headerInfo = PatchEngine.canRomGetHeader(romFile);
      if (headerInfo) {
        fakeHeaderSize = headerInfo.size;
        romFile = _createRomWithFakeHeader(romFile, headerInfo.size, createOutputFile);
      }
    }
    return {
      extractedHeader: extractedHeader,
      fakeHeaderSize: fakeHeaderSize,
      romFile: romFile,
    };
  };
  const _createPatchSequenceContext = (
    romFile: CoreRomPatchFileLike,
    options: ApplyPatchOptions,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
  ): PatchSequenceContext => {
    const preparedRom = _prepareRomForPatchSequence(romFile, options, createOutputFile);
    return {
      originalRomFileName: romFile.fileName,
      originalRomFileType: romFile.fileType,
      preparedRom: preparedRom,
      romFile: preparedRom.romFile,
    };
  };
  const _finalizePatchedRomHeaders = (
    patchedRom: MutablePatchedRom,
    extractedHeader: CoreRomPatchFileLike | false,
    fakeHeaderSize: number,
    options: ApplyPatchOptions,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
  ) => {
    if (extractedHeader) {
      if (options.fixChecksum) PatchEngine.fixRomHeaderChecksum(patchedRom);
      return _createFileWithPrependedHeader(extractedHeader, patchedRom, createOutputFile);
    }
    if (fakeHeaderSize) {
      const patchedRomWithoutFakeHeader = createOutputFile(patchedRom.fileSize - fakeHeaderSize);
      patchedRom.copyTo(patchedRomWithoutFakeHeader, fakeHeaderSize, patchedRom.fileSize - fakeHeaderSize, 0);
      if (options.fixChecksum) PatchEngine.fixRomHeaderChecksum(patchedRomWithoutFakeHeader);
      return patchedRomWithoutFakeHeader;
    }
    if (options.fixChecksum) PatchEngine.fixRomHeaderChecksum(patchedRom);
    return patchedRom;
  };
  const _resolvePatchedOutputName = (
    originalRomFileName: string,
    patches: ParsedPatchLike[],
    patchedRom: MutablePatchedRom,
    options: ApplyPatchOptions,
  ) =>
    _getOutputFileNameFromOptions(originalRomFileName, options) ||
    (options.appendOutputSuffix
      ? _getPatchedSuffixFileName(originalRomFileName, patchedRom.unpatched)
      : _generatePatchedFileName(originalRomFileName, patches, options));
  const _createSequenceApplyOptions = (
    options: ApplyPatchOptions,
    createOutputFile: OutputFileFactory<CoreRomPatchFileLike>,
    includeRuntimeOptions: boolean,
  ) => {
    const applyOptions: ApplyOptionRecord = options.outputFileFactory ? { outputFileFactory: createOutputFile } : {};
    if (includeRuntimeOptions) {
      if (options.opfsManager) applyOptions.opfsManager = options.opfsManager;
      if (typeof options.onProgress === "function") {
        applyOptions.onProgress = (progress: ProgressEventLike | ProgressInput) => {
          if (progress && typeof progress === "object" && "label" in progress) {
            options.onProgress?.(progress as ProgressEventLike);
          }
        };
      }
      if (typeof options.onTrace === "function") applyOptions.onTrace = options.onTrace;
      if (options.workerThreads !== undefined) applyOptions.workerThreads = options.workerThreads;
    }
    return Object.keys(applyOptions).length ? applyOptions : undefined;
  };
  const _normalizeCreatePatchFormat = (format: string | number | null | undefined): CreatePatchFormat => {
    if (typeof format === "string") return format.trim().toLowerCase() as CreatePatchFormat;
    if (typeof format === "undefined") return "ips";
    return String(format).trim().toLowerCase() as CreatePatchFormat;
  };
  const _getPatchMetadataDescription = (metadata: PatchMetadata | null | undefined): string | null =>
    typeof metadata?.Description === "string" ? metadata.Description || null : null;
  const _isBrowserFileBacked = (file: CoreRomPatchFileLike) => !!(file as RomWithBrowserBackingFlag)._browserFileBacked;
  const _hasReadableCursor = (file: CoreRomPatchFileLike | null | undefined): file is CoreRomPatchFileLike =>
    !!(
      file &&
      typeof file.fileSize === "number" &&
      typeof file.seek === "function" &&
      typeof file.skip === "function" &&
      typeof file.isEOF === "function" &&
      typeof file.readU8 === "function" &&
      typeof file.readBytes === "function" &&
      typeof file.readString === "function"
    );
  const _hasReadableRandomAccess = (file: CoreRomPatchFileLike | null | undefined): file is CoreRomPatchFileLike =>
    _hasReadableCursor(file) &&
    (typeof file.readIntoAt === "function" ||
      typeof file.readBytesAt === "function" ||
      file._u8array instanceof Uint8Array);
  const _applyParsedPatchAsync = async (
    patch: ParsedPatchLike,
    romFile: CoreRomPatchFileLike,
    validateChecksums?: boolean,
    options?: JsonRecord,
  ): Promise<MutablePatchedRom> =>
    (await patch.apply(romFile, !!validateChecksums, options as JsonRecord | undefined)) as MutablePatchedRom;

  const _applyPatchSequence = async (
    romFile: CoreRomPatchFileLike,
    patches: ParsedPatchLike | ParsedPatchLike[],
    optionsParam: ApplyOptionRecord | null | undefined,
    defaultOutputSuffix: boolean,
  ) => {
    if (!_hasReadableCursor(romFile)) throw new Error("ROM file is not a readable PatchFile-like object");
    patches = _validatePatchList(patches);

    const options = _normalizeApplyPatchOptions(optionsParam, defaultOutputSuffix);
    if (typeof optionsParam === "object" && optionsParam) {
      const optionRecord = optionsParam as ApplyOptionRecord;
      if (optionRecord.opfsManager) options.opfsManager = optionRecord.opfsManager;
      if (typeof optionRecord.onProgress === "function")
        options.onProgress = optionRecord.onProgress as (progress: ProgressEventLike) => void;
    }
    const createOutputFile: OutputFileFactory<CoreRomPatchFileLike> =
      options.outputFileFactory || ((size: number) => new PatchFile(size) as CoreRomPatchFileLike);
    const sequenceContext = _createPatchSequenceContext(romFile, options, createOutputFile);
    const patchSequenceProgress = _createPatchSequenceProgress(patches, options);
    romFile = sequenceContext.romFile;

    let patchedRom: MutablePatchedRom = romFile;
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      if (!patch) throw new Error(`Missing patch at index ${i}`);
      if (options.requireValidation && !(await PatchEngine.validateRomAsync(patchedRom, patch))) {
        throw new Error(`Invalid input ROM checksum for patch ${i + 1}`);
      }

      const applyOptions = _createSequenceApplyOptions(options, createOutputFile, true);
      patchSequenceProgress.reportPatchStart(i);
      const patchProgress = patchSequenceProgress.createPatchProgress(i);
      if (applyOptions && patchProgress) applyOptions.onProgress = patchProgress;

      let nextRom: PatchFileLike;
      if (_shouldApplyWithXdeltaManager(patch)) {
        nextRom = (await _getXdeltaManager().applyPatch(
          patchedRom as object as XdeltaApplyInput,
          _getXdeltaPatchFile(patch),
          applyOptions as object | undefined,
        )) as PatchFileLike;
      } else {
        nextRom = (await patch.apply(patchedRom, false, applyOptions as JsonRecord | undefined)) as PatchFileLike;
      }
      patchedRom = _copyFileIdentity(nextRom, patchedRom);
    }
    patchedRom = _finalizePatchedRomHeaders(
      patchedRom,
      sequenceContext.preparedRom.extractedHeader,
      sequenceContext.preparedRom.fakeHeaderSize,
      options,
      createOutputFile,
    );

    patchedRom.fileName = _resolvePatchedOutputName(sequenceContext.originalRomFileName, patches, patchedRom, options);
    patchedRom.fileType = sequenceContext.originalRomFileType;

    return patchedRom;
  };

  const _getRomSystem = (binFile: PatchFileLike) => {
    /* to-do: add more systems */
    const extension = typeof binFile.getExtension === "function" ? binFile.getExtension().trim() : "";
    if (binFile.fileSize > 0x0200 && binFile.fileSize % 4 === 0) {
      if ((extension === "gb" || extension === "gbc") && binFile.fileSize % 0x4000 === 0) {
        binFile.seek(0x0104);
        let valid = true;
        for (let i = 0; i < GAME_BOY_NINTENDO_LOGO.length && valid; i++) {
          if (GAME_BOY_NINTENDO_LOGO[i] !== binFile.readU8()) valid = false;
        }
        if (valid) return "gb";
      } else if (extension === "md" || extension === "bin") {
        binFile.seek(0x0100);
        if (SEGA_GENESIS_HEADER_REGEX.test(binFile.readString(12))) return "smd";
      } else if (extension === "z64" && binFile.fileSize >= 0x400000) {
        return "n64";
      }
    } else if (extension === "fds" && binFile.fileSize % 65500 === 0) {
      return "fds";
    }
    return null;
  };
  const _getRomAdditionalChecksum = (binFile: PatchFileLike) => {
    /* to-do: add more systems */
    const romSystem = _getRomSystem(binFile);
    if (romSystem === "n64") {
      binFile.seek(0x3c);
      const cartId = binFile.readString(3);

      binFile.seek(0x10);
      const crc = Array.from(binFile.readBytes(8)).reduce((hex: string, b: number) => {
        if (b < 16) return `${hex}0${b.toString(16)}`;
        return hex + b.toString(16);
      }, "");
      return `${cartId} (${crc})`;
    }
    return null;
  };

  return {
    /* add fake ROM header */
    addFakeHeader: (romFile: CoreRomPatchFileLike) => {
      const headerInfo = PatchEngine.canRomGetHeader(romFile);
      if (headerInfo) {
        const romWithFakeHeader = new PatchFile(headerInfo.size + romFile.fileSize) as CoreRomPatchFileLike;
        romWithFakeHeader.fileName = romFile.fileName;
        romWithFakeHeader.fileType = romFile.fileType;
        romFile.copyTo(romWithFakeHeader, 0, romFile.fileSize, headerInfo.size);

        //add a correct FDS header
        if (_getRomSystem(romWithFakeHeader as PatchFileLike) === "fds") {
          romWithFakeHeader.seek(0);
          (
            romWithFakeHeader as typeof romWithFakeHeader & {
              writeBytes: (bytes: number[]) => void;
            }
          ).writeBytes([0x46, 0x44, 0x53, 0x1a, romFile.fileSize / 65500]);
        }

        (romWithFakeHeader as MutablePatchedRom).fakeHeader = true;

        return romWithFakeHeader;
      }
      return null;
    },

    applyPatch: (
      romFile: CoreRomPatchFileLike,
      patch: ParsedPatchLike,
      optionsParam: ApplyOptionRecord | null | undefined,
    ) => _applyPatchSequence(romFile, [patch], optionsParam, true),

    applyPatchSequence: (
      romFile: CoreRomPatchFileLike,
      patches: ParsedPatchLike | ParsedPatchLike[],
      optionsParam: ApplyOptionRecord | null | undefined,
    ) => _applyPatchSequence(romFile, patches, optionsParam, false),

    /* check if ROM can inject a fake header (for patches that require a headered ROM) */
    canRomGetHeader: (romFile: CoreRomPatchFileLike) => {
      const extension = typeof romFile.getExtension === "function" ? romFile.getExtension() : "";
      if (romFile.fileSize <= 0x600000) {
        const compatibleHeader = HEADERS_INFO.find(
          (headerInfo) =>
            headerInfo.extensions.indexOf(extension) !== -1 && romFile.fileSize % headerInfo.romSizeMultiple === 0,
        );
        if (compatibleHeader) {
          return {
            name: compatibleHeader.name,
            size: compatibleHeader.size,
          };
        }
      }
      return null;
    },

    createPatch: async (
      originalFile: CoreRomPatchFileLike,
      modifiedFile: CoreRomPatchFileLike,
      format: string | number | null | undefined,
      metadata: PatchMetadata | null | undefined,
      options?: {
        outputFileFactory?: ((size: number) => RuntimeValue) | null;
        opfsManager?: OpfsManagerLike | null;
        workerThreads?: string | number | null;
      } | null,
    ) => {
      if (!_hasReadableRandomAccess(originalFile))
        throw new Error("Original ROM file is not a readable random-access PatchFile-like object");
      if (!_hasReadableRandomAccess(modifiedFile))
        throw new Error("Modified ROM file is not a readable random-access PatchFile-like object");

      format = _normalizeCreatePatchFormat(format);

      let patch: ParsedPatchLike;
      if (format === "bps") {
        patch = (await BPS.buildFromRomsAsync(
          originalFile as object as BpsBuildInput,
          modifiedFile as object as Parameters<typeof BPS.buildFromRomsAsync>[1],
          originalFile.fileSize <= 4194304,
        )) as object as ParsedPatchLike;
      } else if (format === "ups") {
        patch = (await UPS.buildFromRomsAsync(
          originalFile as object as UpsBuildInput,
          modifiedFile as object as Parameters<typeof UPS.buildFromRomsAsync>[1],
        )) as object as ParsedPatchLike;
      } else if (format === "rup") {
        patch = (await RUP.buildFromRomsAsync(
          originalFile as object as RupBuildInput,
          modifiedFile as object as Parameters<typeof RUP.buildFromRomsAsync>[1],
          _getPatchMetadataDescription(metadata) || undefined,
        )) as object as ParsedPatchLike;
      } else if (_isXdeltaCreateFormat(format)) {
        const patchFile = await _getXdeltaManager().createPatch(
          originalFile as object as XdeltaCreateInput,
          modifiedFile as object as Parameters<XdeltaManagerLike["createPatch"]>[1],
          {
            opfsManager: options?.opfsManager || undefined,
            outputFileFactory: options?.outputFileFactory || undefined,
            workerThreads: options?.workerThreads,
          },
        );
        patchFile.fileName = `${
          typeof (modifiedFile as CoreRomPatchFileLike & { getName?: () => string }).getName === "function"
            ? (modifiedFile as CoreRomPatchFileLike & { getName: () => string }).getName()
            : modifiedFile.fileName || "patch"
        }.xdelta`;
        patch = (await PatchEngine.parsePatchFile(patchFile as PatchParserInput)) as ParsedPatchLike;
        if (!patch) throw new Error("Could not parse created xdelta patch");
      } else if (format === "ips") {
        patch = IPS.buildFromRoms(
          originalFile as object as IpsBuildInput,
          modifiedFile as object as Parameters<typeof IPS.buildFromRoms>[1],
        ) as object as ParsedPatchLike;
      } else if (format === "ppf") {
        patch = PPF.buildFromRoms(
          originalFile as object as PpfBuildInput,
          modifiedFile as object as Parameters<typeof PPF.buildFromRoms>[1],
        ) as object as ParsedPatchLike;
      } else if (format === "aps") {
        patch = APS.buildFromRoms(
          originalFile as object as ApsBuildInput,
          modifiedFile as object as Parameters<typeof APS.buildFromRoms>[1],
        ) as object as ParsedPatchLike;
      } else if (format === "ebp") {
        patch = (IPS.buildFromRoms as object as SyncPatchBuilderWithMetadata)(originalFile, modifiedFile, metadata);
      } else {
        throw new Error("Invalid patch format");
      }

      const canVerifyPatchInMemory =
        !(_isBrowserFileBacked(originalFile) || _isBrowserFileBacked(modifiedFile)) &&
        (!_isXdeltaCreateFormat(format) || _hasPathBackedXdeltaPatchSource(patch));
      if (canVerifyPatchInMemory && !(format === "ppf" && originalFile.fileSize > modifiedFile.fileSize)) {
        const patchedFile = _isXdeltaCreateFormat(format)
          ? await PatchEngine.applyPatch(originalFile as CoreRomPatchFileLike, patch, {
              appendOutputSuffix: false,
              opfsManager: options?.opfsManager || undefined,
              workerThreads: options?.workerThreads,
            })
          : await _applyParsedPatchAsync(patch, originalFile);
        if ((await computeCRC32(modifiedFile)) !== (await computeCRC32(patchedFile))) {
          //throw new Error('Unexpected error: verification failed. Patched file and modified file mismatch. Please report this bug.');
        }
      }
      return patch;
    },

    /* get ROM internal checksum, if possible */
    fixRomHeaderChecksum: (romFile: CoreRomPatchFileLike) => {
      const romSystem = _getRomSystem(romFile);
      const writableRomFile = romFile as CoreRomPatchFileLike & {
        writeU8: (value: number) => void;
        readU16: () => number;
        writeU16: (value: number) => void;
      };

      if (romSystem === "gb") {
        /* get current checksum */
        romFile.seek(0x014d);
        const currentChecksum = romFile.readU8();

        /* calculate checksum */
        let newChecksum = 0x00;
        romFile.seek(0x0134);
        for (let i = 0; i <= 0x18; i++) {
          newChecksum = ((newChecksum - romFile.readU8() - 1) >>> 0) & 0xff;
        }

        /* fix checksum */
        if (currentChecksum !== newChecksum) {
          romFile.seek(0x014d);
          writableRomFile.writeU8(newChecksum);
          return true;
        }
      } else if (romSystem === "smd") {
        /* get current checksum */
        romFile.seek(0x018e);
        const currentChecksum = writableRomFile.readU16();

        /* calculate checksum */
        let newChecksum = 0x0000;
        romFile.seek(0x0200);
        while (!romFile.isEOF()) {
          newChecksum = ((newChecksum + writableRomFile.readU16()) >>> 0) & 0xffff;
        }

        /* fix checksum */
        if (currentChecksum !== newChecksum) {
          romFile.seek(0x018e);
          writableRomFile.writeU16(newChecksum);
          return true;
        }
      }

      return false;
    },

    generatePatchedFileName: (
      romFile: CoreRomPatchFileLike,
      patches: ParsedPatchLike | ParsedPatchLike[],
      optionsParam: ApplyOptionRecord | null | undefined,
    ) => {
      if (!_hasReadableCursor(romFile)) throw new Error("ROM file is not a readable PatchFile-like object");

      if (!Array.isArray(patches)) patches = [patches];

      const options = _normalizeApplyPatchOptions(optionsParam, false);
      return _generatePatchedFileName(romFile.fileName, patches, options);
    },

    /* get ROM additional checksum info, if possible */
    getRomAdditionalChecksum: (romFile: CoreRomPatchFileLike) => _getRomAdditionalChecksum(romFile),

    /* check if ROM has a known header */
    isRomHeadered: (romFile: CoreRomPatchFileLike) => {
      const extension = typeof romFile.getExtension === "function" ? romFile.getExtension() : "";
      if (romFile.fileSize <= 0x600200 && romFile.fileSize % 1024 !== 0) {
        const compatibleHeader = HEADERS_INFO.find(
          (headerInfo) =>
            headerInfo.extensions.indexOf(extension) !== -1 &&
            (romFile.fileSize - headerInfo.size) % headerInfo.romSizeMultiple === 0,
        );
        if (compatibleHeader) {
          return {
            name: compatibleHeader.name,
            size: compatibleHeader.size,
          };
        }
      }
      return null;
    },

    /* check if ROM is too big */
    isRomTooBig: (romFile: CoreRomPatchFileLike | null | undefined) => !!romFile && romFile.fileSize > TOO_BIG_ROM_SIZE,
    parsePatchFile: async (patchFile: PatchParserInput): Promise<ParsedPatchResult> => {
      if (!_hasReadableCursor(patchFile)) throw new Error("Patch file is not a readable PatchFile-like object");

      patchFile.littleEndian = false;
      patchFile.seek(0);

      var header = patchFile.readString(8);
      let patch: ParsedPatchResult = null;
      if (header.startsWith(IPS.MAGIC)) {
        patch = IPS.fromFile(patchFile as object as IpsPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(UPS.MAGIC)) {
        patch = (await UPS.fromFileAsync(patchFile as object as UpsPatchFileInput)) as object as ParsedPatchResult;
      } else if (header.startsWith(APS.MAGIC)) {
        patch = APS.fromFile(patchFile as object as ApsPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(APSGBA.MAGIC)) {
        patch = APSGBA.fromFile(patchFile as object as ApsGbaPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(BPS.MAGIC)) {
        patch = (await BPS.fromFileAsync(patchFile as object as BpsPatchFileInput)) as object as ParsedPatchResult;
      } else if (header.startsWith(RUP.MAGIC)) {
        patch = RUP.fromFile(patchFile as object as RupPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(PPF.MAGIC)) {
        patch = PPF.fromFile(patchFile as object as PpfPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(BDF.MAGIC)) {
        patch = BDF.fromFile(patchFile as object as BdfPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(PMSR.MAGIC)) {
        patch = PMSR.fromFile(patchFile as object as PmsrPatchFileInput) as object as ParsedPatchResult;
      } else if (header.startsWith(VCDIFF.MAGIC)) {
        patch = VCDIFF.fromFile(patchFile as object as VcdiffPatchFileInput) as object as ParsedPatchResult;
      }

      if (patch) patch._originalPatchFile = patchFile;

      return patch;
    },

    /* remove ROM header */
    removeHeader: (romFile: CoreRomPatchFileLike) => {
      const headerInfo = PatchEngine.isRomHeadered(romFile);
      if (headerInfo) {
        return {
          header: romFile.slice(0, headerInfo.size),
          rom: romFile.slice(headerInfo.size),
        };
      }
      return null;
    },
    setXdeltaManager: (manager: XdeltaManagerLike | null) => {
      xdeltaManager = manager;
    },

    validateRomAsync: async (romFile: CoreRomPatchFileLike, patch: ParsedPatchLike, skipHeaderSize?: number) => {
      if (!_hasReadableCursor(romFile)) throw new Error("ROM file is not a readable PatchFile-like object");
      if (typeof patch !== "object") throw new Error("Unknown patch format");

      if (typeof skipHeaderSize !== "number" || skipHeaderSize < 0) skipHeaderSize = 0;

      if (
        typeof patch.validateSourceAsync === "function" &&
        !(await patch.validateSourceAsync(romFile, skipHeaderSize))
      )
        return false;
      return true;
    },
  };
})();

export default PatchEngine;
