/* VCDIFF module for RomWeaver.js v20181021 - Marc Robledo 2018 - http://www.marcrobledo.com/license */
/* File format specification: https://tools.ietf.org/html/rfc3284 */
/*
	Mostly based in:
	https://github.com/vic-alexiev/TelerikAcademy/tree/master/C%23%20Fundamentals%20II/Homework%20Assignments/3.%20Methods/000.%20MiscUtil/Compression/Vcdiff
	some code and ideas borrowed from:
	https://hack64.net/jscripts/libpatch.js?6
*/
//const VCDIFF_MAGIC=0xd6c3c400;

import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";

const VCDIFF_MAGIC = "\xd6\xc3\xc4";
const VCDIFF_VERSION = 0x00;
const VCDIFF_COPY_CHUNK_SIZE = 1024 * 1024;

type BinaryReadable = {
  fileSize: number;
  _u8array?: Uint8Array;
  readU8At?: (offset: number) => number;
  readBytesAt?: (offset: number, len: number) => Uint8Array;
};

type BinaryWritable = BinaryReadable & {
  writeU8At?: (offset: number, value: number) => void;
  writeBytesAt?: (offset: number, bytes: Uint8Array) => void;
};

type VcdiffOutputFile = {
  fileSize: number;
  seek(offset: number): void;
  writeBytes(bytes: Uint8Array | number[]): void;
  writeU8(value: number): void;
};

type VcdiffInstruction = {
  type: number;
  size: number;
  mode: number;
};

type VcdiffInstructionPair = [VcdiffInstruction, VcdiffInstruction];
type VcdiffCodeTable = VcdiffInstructionPair[];

type VcdiffWindowHeader = {
  indicator: number;
  sourceLength: number;
  sourcePosition: number;
  adler32: number | false;
  deltaLength: number;
  targetWindowLength: number;
  deltaIndicator: number;
  addRunDataLength: number;
  instructionsLength: number;
  addressesLength: number;
  sectionOffset: number;
  windowEndOffset: number;
};

type VcdiffSections = {
  data: Uint8Array;
  instructions: Uint8Array;
  addresses: Uint8Array;
};

type VcdiffHeader = {
  compressionId: number | null;
  codeTable: VcdiffCodeTable;
  nearSize: number;
  sameSize: number;
};

type VcdiffMetadata = {
  targetChecksums: number[];
};

type VcdiffValidationInfo = {
  type: "ADLER32";
  targetValue: number | number[];
  targetChecksumScope?: "target-window";
};

class VCDIFF {
  static readonly MAGIC = VCDIFF_MAGIC;

  file: BinaryReadable;
  isXdeltaPatch = true as const;
  targetChecksums: number[] = [];
  _originalPatchFile?: BinaryReadable;

  constructor(patchFile: BinaryReadable) {
    this.file = patchFile;
    try {
      this.targetChecksums = _readPatchMetadata(patchFile).targetChecksums;
    } catch (_error) {
      // Older VCDIFF patches may not include metadata.
    }
  }

  async apply(romFile: BinaryReadable, validate: boolean, applyOptions?: PatchApplyOptions<VcdiffOutputFile>) {
    void romFile;
    void validate;
    void applyOptions;
    throw new Error("VCDIFF/xdelta patches require RomWeaver.applyPatch() or RomWeaver.applyPatchSequence()");
  }

  export(fileName?: string) {
    const sourceFile = this._originalPatchFile || this.file;
    const sourceBytes =
      sourceFile._u8array instanceof Uint8Array
        ? sourceFile._u8array
        : (() => {
            if (typeof sourceFile.readBytesAt === "function") {
              return sourceFile.readBytesAt(0, sourceFile.fileSize);
            }
            return null;
          })();
    if (!(sourceBytes instanceof Uint8Array)) throw new Error("VCDIFF/xdelta patch source is not exportable");

    const buffer = new Uint8Array(sourceBytes.byteLength);
    buffer.set(sourceBytes);
    const patchFile = new PatchFile(buffer.buffer);
    patchFile.fileName = `${fileName || "patch"}.xdelta`;
    return patchFile;
  }

  getValidationInfo() {
    if (!this.targetChecksums.length) return null;
    const targetValue =
      this.targetChecksums.length === 1 ? (this.targetChecksums[0] ?? 0) : this.targetChecksums.slice();
    const info: VcdiffValidationInfo = {
      targetValue,
      type: "ADLER32",
    };
    if (this.targetChecksums.length > 1) info.targetChecksumScope = "target-window";
    return info;
  }

  toString() {
    return "VCDIFF patch";
  }

  static fromFile(file: BinaryReadable) {
    return new VCDIFF(file);
  }
}

function _readPatchMetadata(file: BinaryReadable): VcdiffMetadata {
  const parser = new VCDIFF_Parser(file);
  _readHeaderMetadata(parser);
  const targetChecksums: number[] = [];

  while (!parser.isEOF()) {
    const winHeader = _readWindowHeader(parser);
    if (winHeader.adler32 !== false) targetChecksums.push(winHeader.adler32 >>> 0);
    parser.seek(winHeader.windowEndOffset);
  }

  return {
    targetChecksums,
  };
}

function _readHeaderMetadata(parser: VCDIFF_Parser) {
  const header = _readBaseHeader(parser);
  if (header.headerIndicator & VCD_CODETABLE) {
    const codeTableDataLength = parser.read7BitEncodedInt();
    parser.skip(codeTableDataLength);
  }

  if (header.headerIndicator & VCD_APPHEADER) {
    const appDataLength = parser.read7BitEncodedInt();
    parser.skip(appDataLength);
  }
}

function _readBaseHeader(parser: VCDIFF_Parser) {
  if (parser.readU8() !== 0xd6 || parser.readU8() !== 0xc3 || parser.readU8() !== 0xc4)
    throw new Error("Invalid VCDIFF magic");
  const version = parser.readU8();
  if (version !== VCDIFF_VERSION) throw new Error(`Unsupported VCDIFF version: ${version}`);

  const headerIndicator = parser.readU8();
  if (headerIndicator & ~(VCD_DECOMPRESS | VCD_CODETABLE | VCD_APPHEADER))
    throw new Error(`Unsupported VCDIFF header indicator: ${headerIndicator}`);

  var compressionId: number | null = null;
  if (headerIndicator & VCD_DECOMPRESS) compressionId = parser.readU8();

  return {
    compressionId,
    headerIndicator,
  };
}

function _readHeader(parser: VCDIFF_Parser): VcdiffHeader {
  const header = _readBaseHeader(parser);

  var codeTable: VcdiffCodeTable = VCD_DEFAULT_CODE_TABLE;
  var nearSize = 4;
  var sameSize = 3;
  if (header.headerIndicator & VCD_CODETABLE) {
    const codeTableDataLength = parser.read7BitEncodedInt();
    const codeTableDataEnd = parser.offset + codeTableDataLength;
    if (codeTableDataLength < 2) throw new Error("Invalid VCDIFF code table data length");

    nearSize = parser.readU8();
    sameSize = parser.readU8();
    codeTable = _decodeCodeTable(parser.readBytes(codeTableDataLength - 2), header.compressionId, nearSize, sameSize);
    if (parser.offset !== codeTableDataEnd) throw new Error("Invalid VCDIFF code table data");
  }

  if (header.headerIndicator & VCD_APPHEADER) {
    const appDataLength = parser.read7BitEncodedInt();
    parser.skip(appDataLength);
  }

  return {
    codeTable,
    compressionId: header.compressionId,
    nearSize,
    sameSize,
  };
}
void _readHeader;

function _readWindowHeader(parser: VCDIFF_Parser): VcdiffWindowHeader {
  const windowHeader: VcdiffWindowHeader = {
    addRunDataLength: 0,
    addressesLength: 0,
    adler32: false,
    deltaIndicator: 0,
    deltaLength: 0,
    indicator: parser.readU8(),
    instructionsLength: 0,
    sectionOffset: 0,
    sourceLength: 0,
    sourcePosition: 0,
    targetWindowLength: 0,
    windowEndOffset: 0,
  };

  if (windowHeader.indicator & VCD_SOURCE && windowHeader.indicator & VCD_TARGET)
    throw new Error("Invalid VCDIFF window indicator: source and target are both set");
  if (windowHeader.indicator & ~(VCD_SOURCE | VCD_TARGET | VCD_ADLER32))
    throw new Error(`Unsupported VCDIFF window indicator: ${windowHeader.indicator}`);

  if (windowHeader.indicator & (VCD_SOURCE | VCD_TARGET)) {
    windowHeader.sourceLength = parser.read7BitEncodedInt();
    windowHeader.sourcePosition = parser.read7BitEncodedInt();
  }

  const deltaEncoding = _readDeltaEncoding(parser, !!(windowHeader.indicator & VCD_ADLER32));
  return { ...windowHeader, ...deltaEncoding };
}

function _readDeltaEncoding(
  parser: VCDIFF_Parser,
  hasAdler32: boolean,
): Omit<VcdiffWindowHeader, "indicator" | "sourceLength" | "sourcePosition"> {
  const deltaEncoding: Omit<VcdiffWindowHeader, "indicator" | "sourceLength" | "sourcePosition"> = {
    addRunDataLength: 0,
    addressesLength: 0,
    adler32: false,
    deltaIndicator: 0,
    deltaLength: parser.read7BitEncodedInt(),
    instructionsLength: 0,
    sectionOffset: 0,
    targetWindowLength: 0,
    windowEndOffset: 0,
  };
  const deltaEndOffset = parser.offset + deltaEncoding.deltaLength;

  deltaEncoding.targetWindowLength = parser.read7BitEncodedInt();
  deltaEncoding.deltaIndicator = parser.readU8();
  if (deltaEncoding.deltaIndicator & ~(VCD_DATACOMP | VCD_INSTCOMP | VCD_ADDRCOMP))
    throw new Error(`Unsupported VCDIFF delta indicator: ${deltaEncoding.deltaIndicator}`);

  deltaEncoding.addRunDataLength = parser.read7BitEncodedInt();
  deltaEncoding.instructionsLength = parser.read7BitEncodedInt();
  deltaEncoding.addressesLength = parser.read7BitEncodedInt();

  if (hasAdler32) deltaEncoding.adler32 = parser.readU32();

  deltaEncoding.sectionOffset = parser.offset;
  deltaEncoding.windowEndOffset = deltaEndOffset;
  if (
    deltaEncoding.sectionOffset +
      deltaEncoding.addRunDataLength +
      deltaEncoding.instructionsLength +
      deltaEncoding.addressesLength !==
    deltaEndOffset
  ) {
    throw new Error("Invalid VCDIFF delta section lengths");
  }

  return deltaEncoding;
}

function _readDeltaSections(
  parser: VCDIFF_Parser,
  deltaEncoding: Pick<
    VcdiffWindowHeader,
    | "sectionOffset"
    | "addRunDataLength"
    | "instructionsLength"
    | "addressesLength"
    | "windowEndOffset"
    | "deltaIndicator"
  >,
  compressionId: number | null,
): VcdiffSections {
  parser.seek(deltaEncoding.sectionOffset);
  const data = parser.readBytes(deltaEncoding.addRunDataLength);
  const instructions = parser.readBytes(deltaEncoding.instructionsLength);
  const addresses = parser.readBytes(deltaEncoding.addressesLength);
  const sections: VcdiffSections = { addresses, data, instructions };
  if (parser.offset !== deltaEncoding.windowEndOffset) throw new Error("Invalid VCDIFF delta section data");

  if (deltaEncoding.deltaIndicator & VCD_DATACOMP)
    sections.data = _decodeCompressedSection(compressionId, sections.data, "data");
  if (deltaEncoding.deltaIndicator & VCD_INSTCOMP)
    sections.instructions = _decodeCompressedSection(compressionId, sections.instructions, "instructions");
  if (deltaEncoding.deltaIndicator & VCD_ADDRCOMP)
    sections.addresses = _decodeCompressedSection(compressionId, sections.addresses, "addresses");

  return sections;
}

function _decodeCompressedSection(compressionId: number | null, data: Uint8Array, sectionName: string): never {
  void data;
  throw new Error(`Unsupported VCDIFF compressed ${sectionName} section codec ID: ${compressionId}`);
}

function _decodeCodeTable(
  codeTableDeltaData: Uint8Array,
  compressionId: number | null,
  nearSize: number,
  sameSize: number,
) {
  const parser = new VCDIFF_Parser(codeTableDeltaData);
  const deltaEncoding = _readDeltaEncoding(parser, false);
  const sections = _readDeltaSections(parser, deltaEncoding, compressionId);
  if (!parser.isEOF()) throw new Error("Invalid VCDIFF code table delta");
  if (deltaEncoding.targetWindowLength !== 1536) throw new Error("Invalid VCDIFF code table size");

  const defaultCodeTableBytes = _codeTableToBytes(VCD_DEFAULT_CODE_TABLE);
  const sourceFile: BinaryReadable = { _u8array: defaultCodeTableBytes, fileSize: defaultCodeTableBytes.length };
  const targetFile: BinaryWritable = {
    _u8array: new Uint8Array(deltaEncoding.targetWindowLength),
    fileSize: deltaEncoding.targetWindowLength,
  };
  const codeTableWindowHeader: VcdiffWindowHeader = {
    addRunDataLength: deltaEncoding.addRunDataLength,
    addressesLength: deltaEncoding.addressesLength,
    adler32: false,
    deltaIndicator: deltaEncoding.deltaIndicator,
    deltaLength: deltaEncoding.deltaLength,
    indicator: VCD_SOURCE,
    instructionsLength: deltaEncoding.instructionsLength,
    sectionOffset: deltaEncoding.sectionOffset,
    sourceLength: defaultCodeTableBytes.length,
    sourcePosition: 0,
    targetWindowLength: deltaEncoding.targetWindowLength,
    windowEndOffset: deltaEncoding.windowEndOffset,
  };
  _decodeTargetWindow(sourceFile, targetFile, 0, codeTableWindowHeader, VCD_DEFAULT_CODE_TABLE, 4, 3, sections);
  return _bytesToCodeTable(targetFile._u8array as Uint8Array, nearSize, sameSize);
}

function _decodeTargetWindow(
  sourceFile: BinaryReadable,
  targetFile: BinaryWritable,
  targetWindowPosition: number,
  winHeader: VcdiffWindowHeader,
  codeTable: VcdiffCodeTable,
  nearSize: number,
  sameSize: number,
  sections: VcdiffSections,
) {
  if (winHeader.indicator & VCD_SOURCE) _validateSourceSegment(sourceFile, winHeader);
  else if (winHeader.indicator & VCD_TARGET) _validateSourceSegment(targetFile, winHeader, targetWindowPosition);

  const addRunDataStream = new VCDIFF_Parser(sections.data);
  const instructionsStream = new VCDIFF_Parser(sections.instructions);
  const addressesStream = new VCDIFF_Parser(sections.addresses);
  const cache = new VCD_AdressCache(nearSize, sameSize);
  var addRunDataIndex = 0;

  cache.reset(addressesStream);

  while (!instructionsStream.isEOF()) {
    const instructionIndex = instructionsStream.readU8();
    const instructionPair = codeTable[instructionIndex];
    if (!instructionPair) throw new Error(`Invalid VCDIFF instruction index: ${instructionIndex}`);

    for (let i = 0; i < 2; i++) {
      const instruction = instructionPair[i];
      if (!instruction) continue;
      let size = instruction.size;

      if (size === 0 && instruction.type !== VCD_NOOP) size = instructionsStream.read7BitEncodedInt();

      if (instruction.type === VCD_NOOP) {
        continue;
      }
      if (instruction.type === VCD_ADD) {
        addRunDataStream.copyToFile2(targetFile, addRunDataIndex + targetWindowPosition, size);
        addRunDataIndex += size;
      } else if (instruction.type === VCD_COPY) {
        const addr = cache.decodeAddress(addRunDataIndex + winHeader.sourceLength, instruction.mode);
        let absAddr = 0;
        let sourceData: BinaryReadable | BinaryWritable | null = null;
        if (addr < winHeader.sourceLength) {
          absAddr = winHeader.sourcePosition + addr;
          if (winHeader.indicator & VCD_SOURCE) sourceData = sourceFile;
          else if (winHeader.indicator & VCD_TARGET) sourceData = targetFile;
        } else {
          absAddr = targetWindowPosition + (addr - winHeader.sourceLength);
          sourceData = targetFile;
        }
        if (!sourceData) throw new Error("Invalid VCDIFF COPY source");
        _validateCopy(sourceData, absAddr, size);

        _copyFileBytes(sourceData, targetFile, absAddr, targetWindowPosition + addRunDataIndex, size);
        addRunDataIndex += size;
      } else if (instruction.type === VCD_RUN) {
        const runByte = addRunDataStream.readU8();
        const offset = targetWindowPosition + addRunDataIndex;
        for (let j = 0; j < size; j++) _writeFileByte(targetFile, offset + j, runByte);

        addRunDataIndex += size;
      } else {
        throw new Error(`Invalid VCDIFF instruction type: ${instruction.type}`);
      }

      if (addRunDataIndex > winHeader.targetWindowLength) throw new Error("VCDIFF target window overflow");
    }
  }

  if (addRunDataIndex !== winHeader.targetWindowLength) throw new Error("VCDIFF target window length mismatch");
  if (!addRunDataStream.isEOF()) throw new Error("VCDIFF data section was not fully consumed");
  if (!addressesStream.isEOF()) throw new Error("VCDIFF address section was not fully consumed");
}

function _validateSourceSegment(
  sourceFile: BinaryReadable | BinaryWritable,
  winHeader: Pick<VcdiffWindowHeader, "sourcePosition" | "sourceLength">,
  targetWindowPosition?: number,
) {
  const sourceSize = _fileSize(sourceFile);
  const sourceEnd = winHeader.sourcePosition + winHeader.sourceLength;
  if (sourceEnd > sourceSize) throw new Error("VCDIFF source segment is out of bounds");
  if (typeof targetWindowPosition === "number" && sourceEnd > targetWindowPosition)
    throw new Error("VCDIFF target source segment is out of bounds");
}

function _validateCopy(sourceFile: BinaryReadable | BinaryWritable, offset: number, len: number) {
  if (offset < 0 || offset + len > _fileSize(sourceFile)) throw new Error("VCDIFF COPY source is out of bounds");
}

function _fileSize(file: BinaryReadable | BinaryWritable) {
  return typeof file.fileSize === "number" ? file.fileSize : file._u8array?.length || 0;
}

function _readFileByte(file: BinaryReadable | BinaryWritable, offset: number) {
  if (typeof file.readU8At === "function") return file.readU8At(offset);
  return file._u8array?.[offset] ?? 0;
}

function _writeFileByte(file: BinaryWritable, offset: number, value: number) {
  if (typeof file.writeU8At === "function") file.writeU8At(offset, value);
  else if (file._u8array) file._u8array[offset] = value;
}

function _writeFileBytes(file: BinaryWritable, offset: number, bytes: Uint8Array) {
  if (typeof file.writeBytesAt === "function") file.writeBytesAt(offset, bytes);
  else file._u8array?.set(bytes, offset);
}

function _canBulkCopyFileBytes(
  sourceFile: BinaryReadable | BinaryWritable,
  targetFile: BinaryWritable,
  sourceOffset: number,
  targetOffset: number,
  len: number,
) {
  if (typeof sourceFile.readBytesAt !== "function" || typeof targetFile.writeBytesAt !== "function") return false;
  if (sourceFile !== targetFile) return true;
  return !(targetOffset > sourceOffset && targetOffset < sourceOffset + len);
}

function _copyFileBytes(
  sourceFile: BinaryReadable | BinaryWritable,
  targetFile: BinaryWritable,
  sourceOffset: number,
  targetOffset: number,
  len: number,
) {
  if (len <= 0) return;

  if (_canBulkCopyFileBytes(sourceFile, targetFile, sourceOffset, targetOffset, len) && sourceFile.readBytesAt) {
    let copied = 0;
    while (copied < len) {
      const chunkLength = Math.min(VCDIFF_COPY_CHUNK_SIZE, len - copied);
      const bytes = sourceFile.readBytesAt(sourceOffset + copied, chunkLength);
      if (bytes.length !== chunkLength) throw new Error("Unexpected end of VCDIFF COPY source");
      _writeFileBytes(targetFile, targetOffset + copied, bytes);
      copied += chunkLength;
    }
    return;
  }

  while (len--) _writeFileByte(targetFile, targetOffset++, _readFileByte(sourceFile, sourceOffset++));
}

function _codeTableToBytes(codeTable: VcdiffCodeTable) {
  const bytes = new Uint8Array(1536);
  for (let i = 0; i < 256; i++) {
    const pair = codeTable[i];
    if (!pair) continue;
    bytes[i] = pair[0].type;
    bytes[256 + i] = pair[1].type;
    bytes[512 + i] = pair[0].size;
    bytes[768 + i] = pair[1].size;
    bytes[1024 + i] = pair[0].mode;
    bytes[1280 + i] = pair[1].mode;
  }
  return bytes;
}

function _bytesToCodeTable(bytes: Uint8Array, nearSize: number, sameSize: number) {
  if (bytes.length !== 1536) throw new Error("Invalid VCDIFF code table size");

  const codeTable: VcdiffCodeTable = [];
  for (let i = 0; i < 256; i++) {
    const pair: VcdiffInstructionPair = [
      { mode: bytes[1024 + i] ?? 0, size: bytes[512 + i] ?? 0, type: bytes[i] ?? 0 },
      { mode: bytes[1280 + i] ?? 0, size: bytes[768 + i] ?? 0, type: bytes[256 + i] ?? 0 },
    ];
    codeTable[i] = pair;
    _validateCodeTableInstruction(pair[0], nearSize, sameSize);
    _validateCodeTableInstruction(pair[1], nearSize, sameSize);
  }
  return codeTable;
}

function _validateCodeTableInstruction(instruction: VcdiffInstruction, nearSize: number, sameSize: number) {
  if (instruction.type < VCD_NOOP || instruction.type > VCD_COPY)
    throw new Error("Invalid VCDIFF code table instruction type");
  if (instruction.type === VCD_COPY && instruction.mode > nearSize + sameSize + 1)
    throw new Error("Invalid VCDIFF code table COPY mode");
}

type ParserInput = Uint8Array | ArrayBuffer | BinaryReadable;

type ParserReadableFile = {
  fileSize: number;
  readU8At(offset: number): number;
  readBytesAt(offset: number, len: number): Uint8Array;
};

/* VCDIFF_Parser(binFile */

class VCDIFF_Parser {
  file?: ParserReadableFile;
  _u8array?: Uint8Array;
  fileSize: number;
  offset: number;

  constructor(binFile: ParserInput, offset = 0) {
    if (binFile instanceof Uint8Array) {
      this._u8array = binFile;
      this.fileSize = binFile.length;
      this.offset = offset;
      return;
    }
    if (binFile instanceof ArrayBuffer) {
      const u8array = new Uint8Array(binFile);
      this._u8array = u8array;
      this.fileSize = u8array.length;
      this.offset = offset;
      return;
    }
    if (typeof binFile.readU8At === "function" && typeof binFile.readBytesAt === "function") {
      this.file = binFile as ParserReadableFile;
      this.fileSize = binFile.fileSize;
      this.offset = offset;
      return;
    }
    this._u8array = binFile._u8array;
    this.fileSize = binFile._u8array?.length || 0;
    this.offset = offset;
  }

  copyToFile2(target: BinaryWritable, targetOffset: number, len: number) {
    if (targetOffset + len > _fileSize(target)) throw new Error("VCDIFF target write is out of bounds");
    _writeFileBytes(target, targetOffset, this.readBytes(len));
  }

  isEOF() {
    return !(this.offset < this.fileSize);
  }

  read7BitEncodedInt() {
    var num = 0;
    var bits = 0;

    do {
      bits = this.readU8();
      num = (num << 7) + (bits & 0x7f);
    } while (bits & 0x80);

    return num;
  }

  readBytes(len: number) {
    if (this.offset + len > this.fileSize) throw new Error("Unexpected end of VCDIFF file");
    if (this.file) {
      const fileBytes = this.file.readBytesAt(this.offset, len);
      this.offset += len;
      return fileBytes;
    }
    const bytes = this._u8array?.slice(this.offset, this.offset + len) || new Uint8Array(0);
    this.offset += len;
    return bytes;
  }

  readU8() {
    if (this.offset >= this.fileSize) throw new Error("Unexpected end of VCDIFF file");
    if (this.file) return this.file.readU8At(this.offset++);
    return this._u8array?.[this.offset++] ?? 0;
  }

  readU32() {
    return ((this.readU8() << 24) + (this.readU8() << 16) + (this.readU8() << 8) + this.readU8()) >>> 0;
  }

  seek(offset: number) {
    if (offset < 0 || offset > this.fileSize) throw new Error("VCDIFF parser seek out of bounds");
    this.offset = offset;
  }

  skip(nBytes: number) {
    this.seek(this.offset + nBytes);
  }
}

const VCD_DECOMPRESS = 0x01;
const VCD_CODETABLE = 0x02;
const VCD_APPHEADER = 0x04;

const VCD_SOURCE = 0x01;
const VCD_TARGET = 0x02;
const VCD_ADLER32 = 0x04;

const VCD_DATACOMP = 0x01;
const VCD_INSTCOMP = 0x02;
const VCD_ADDRCOMP = 0x04;

const VCD_NOOP = 0;
const VCD_ADD = 1;
const VCD_RUN = 2;
const VCD_COPY = 3;
const VCD_DEFAULT_CODE_TABLE: VcdiffCodeTable = (() => {
  const entries: VcdiffCodeTable = [];
  const empty: VcdiffInstruction = { mode: 0, size: 0, type: VCD_NOOP };

  entries.push([{ mode: 0, size: 0, type: VCD_RUN }, empty]);

  for (let size = 0; size < 18; size++) {
    entries.push([{ mode: 0, size, type: VCD_ADD }, empty]);
  }

  for (let mode = 0; mode < 9; mode++) {
    entries.push([{ mode, size: 0, type: VCD_COPY }, empty]);

    for (let size = 4; size < 19; size++) {
      entries.push([{ mode, size, type: VCD_COPY }, empty]);
    }
  }

  for (let mode = 0; mode < 6; mode++) {
    for (let addSize = 1; addSize < 5; addSize++) {
      for (let copySize = 4; copySize < 7; copySize++) {
        entries.push([
          { mode: 0, size: addSize, type: VCD_ADD },
          { mode, size: copySize, type: VCD_COPY },
        ]);
      }
    }
  }

  for (let mode = 6; mode < 9; mode++) {
    for (let addSize = 1; addSize < 5; addSize++) {
      entries.push([
        { mode: 0, size: addSize, type: VCD_ADD },
        { mode, size: 4, type: VCD_COPY },
      ]);
    }
  }

  for (let mode = 0; mode < 9; mode++) {
    entries.push([
      { mode, size: 4, type: VCD_COPY },
      { mode: 0, size: 1, type: VCD_ADD },
    ]);
  }

  return entries;
})();

const VCD_MODE_SELF = 0;
const VCD_MODE_HERE = 1;

class VCD_AdressCache {
  nearSize: number;
  sameSize: number;
  near: number[];
  same: number[];
  nextNearSlot = 0;
  addressStream: VCDIFF_Parser;

  constructor(nearSize: number, sameSize: number) {
    this.addressStream = new VCDIFF_Parser(new Uint8Array(0));
    this.near = new Array(nearSize);
    this.nearSize = nearSize;
    this.same = new Array(sameSize * 256);
    this.sameSize = sameSize;
  }

  decodeAddress(here: number, mode: number) {
    var address = 0;

    if (mode === VCD_MODE_SELF) {
      address = this.addressStream.read7BitEncodedInt();
    } else if (mode === VCD_MODE_HERE) {
      address = here - this.addressStream.read7BitEncodedInt();
    } else if (mode - 2 < this.nearSize) {
      address = (this.near[mode - 2] ?? 0) + this.addressStream.read7BitEncodedInt();
    } else if (mode < 2 + this.nearSize + this.sameSize) {
      const m = mode - (2 + this.nearSize);
      address = this.same[m * 256 + this.addressStream.readU8()] ?? 0;
    } else {
      throw new Error(`Invalid VCDIFF address mode: ${mode}`);
    }
    if (address < 0) throw new Error("Invalid VCDIFF decoded address");

    this.update(address);
    return address;
  }

  reset(addressStream: VCDIFF_Parser) {
    this.nextNearSlot = 0;
    this.near.fill(0);
    this.same.fill(0);
    this.addressStream = addressStream;
  }

  update(address: number) {
    if (this.nearSize > 0) {
      this.near[this.nextNearSlot] = address;
      this.nextNearSlot = (this.nextNearSlot + 1) % this.nearSize;
    }

    if (this.sameSize > 0) {
      this.same[address % (this.sameSize * 256)] = address;
    }
  }
}

export default VCDIFF;
