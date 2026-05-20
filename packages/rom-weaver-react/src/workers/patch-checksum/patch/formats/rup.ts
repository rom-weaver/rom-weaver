/* RUP module for Rom Patcher JS v20250430 - Marc Robledo 2018-2025 - http://www.marcrobledo.com/license */
/* File format specification: http://www.romhacking.net/documents/288/ */

import type {
  PatchWritablePatchFile,
  PatchWritablePatchFileWithVlv,
  TypedPatchFileConstructor,
} from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { computeMD5 } from "../../shared/checksum.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { applyXorRecords, assertPatchValidation, createPatchedOutputFile } from "../patch-format-utils.ts";

const RUP_MAGIC = "NINJA2";
const RUP_COMMAND_END = 0x00;
const RUP_COMMAND_OPEN_NEW_FILE = 0x01;
const RUP_COMMAND_XOR_RECORD = 0x02;
const RUP_ROM_TYPES = ["raw", "nes", "fds", "snes", "n64", "gb", "sms", "mega", "pce", "lynx"] as const;

type RupOverflowMode = "A" | "M" | null;

type RupRecord = {
  offset: number;
  xor: number[];
};

type RupFile = {
  fileName: string;
  romType: number;
  sourceFileSize: number;
  targetFileSize: number;
  sourceMD5: string;
  targetMD5: string;
  overflowMode: RupOverflowMode;
  overflowData: number[];
  records: RupRecord[];
};

type WritablePatchFile = Omit<
  PatchWritablePatchFile<
    number[] | Uint8Array,
    {
      fileName?: string;
      readBytes(length: number): number[];
      unpatched?: boolean;
      slice(offset?: number, len?: number, doNotClone?: boolean): WritablePatchFile;
    }
  >,
  "readBytes" | "slice"
> & {
  readBytes(length: number): number[];
  slice(offset?: number, len?: number, doNotClone?: boolean): WritablePatchFile;
};

type WritablePatchFileWithVlv = PatchWritablePatchFileWithVlv<WritablePatchFile>;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class RUP {
  static readonly MAGIC = RUP_MAGIC;

  author = "";
  version = "";
  title = "";
  genre = "";
  language = "";
  date = "";
  web = "";
  description = "";
  textEncoding?: number;
  files: RupFile[] = [];

  async apply(romFile: WritablePatchFile, validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    const validFile = validate
      ? await this.validateSourceAsync(romFile)
      : await (async () => {
          if (this.files[0]) {
            return {
              file: this.files[0],
              undo: this.files[0].targetMD5 === (await computeMD5(romFile)),
            };
          }
          return false;
        })();

    if (!validFile) throw new Error("Source ROM checksum mismatch");

    const undo = validFile.undo;
    const patch = validFile.file;
    const tempFile = createPatchedOutputFile(
      PatchPatchFile,
      romFile,
      undo ? patch.sourceFileSize : patch.targetFileSize,
      applyOptions,
    ) as WritablePatchFile;

    applyXorRecords(
      tempFile,
      romFile,
      patch.records.map((record: RupRecord) => ({ offset: record.offset, xor: record.xor })),
    );

    if (patch.overflowMode === "A" && !undo) {
      tempFile.seek(patch.sourceFileSize);
      tempFile.writeBytes(patch.overflowData.map((byte: number) => byte ^ 0xff));
    } else if (patch.overflowMode === "M" && undo) {
      tempFile.seek(patch.targetFileSize);
      tempFile.writeBytes(patch.overflowData.map((byte: number) => byte ^ 0xff));
    }

    assertPatchValidation(
      validate,
      (!undo && (await computeMD5(tempFile)) === patch.targetMD5) ||
        (undo && (await computeMD5(tempFile)) === patch.sourceMD5),
      "Target ROM checksum mismatch",
    );

    if (undo) tempFile.unpatched = true;

    return tempFile;
  }

  getDescription() {
    return this.description ? this.description : null;
  }

  getValidationInfo() {
    const values: string[] = [];
    const targetValues: string[] = [];
    for (const file of this.files) {
      if (!file) continue;
      values.push(file.sourceMD5);
      targetValues.push(file.targetMD5);
    }
    return {
      targetValue: targetValues,
      type: "MD5" as const,
      value: values,
    };
  }

  toString() {
    var s = `Author: ${this.author}`;
    s += `\nVersion: ${this.version}`;
    s += `\nTitle: ${this.title}`;
    s += `\nGenre: ${this.genre}`;
    s += `\nLanguage: ${this.language}`;
    s += `\nDate: ${this.date}`;
    s += `\nWeb: ${this.web}`;
    s += `\nDescription: ${this.description}`;
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      if (!file) continue;
      s += "\n---------------";
      s += `\nFile ${i}:`;
      s += `\nFile name: ${file.fileName}`;
      s += `\nRom type: ${RUP_ROM_TYPES[file.romType] || "unknown"}`;
      s += `\nSource file size: ${file.sourceFileSize}`;
      s += `\nTarget file size: ${file.targetFileSize}`;
      s += `\nSource MD5: ${file.sourceMD5}`;
      s += `\nTarget MD5: ${file.targetMD5}`;
      if (file.overflowMode === "A") {
        s += `\nOverflow mode: Append ${file.overflowData.length} bytes`;
      } else if (file.overflowMode === "M") {
        s += `\nOverflow mode: Minify ${file.overflowData.length} bytes`;
      }
      s += `\n#records: ${file.records.length}`;
    }
    return s;
  }

  async validateSourceAsync(romFile: WritablePatchFile, headerSize?: number) {
    const md5string = await computeMD5(romFile, headerSize);
    for (const file of this.files) {
      if (file && (file.sourceMD5 === md5string || file.targetMD5 === md5string)) {
        return {
          file,
          undo: file.targetMD5 === md5string,
        };
      }
    }
    return false;
  }

  export(fileName: string) {
    return exportRupPatch.call(this, fileName);
  }

  static padZeroes(intVal: number, nBytes: number) {
    var hexString = intVal.toString(16);
    while (hexString.length < nBytes * 2) hexString = `0${hexString}`;
    return hexString;
  }

  static fromFile(file: WritablePatchFileWithVlv) {
    const patch = new RUP();
    file.readVLV = RUP_readVLV;

    file.seek(RUP_MAGIC.length);

    patch.textEncoding = file.readU8();
    patch.author = file.readString(84);
    patch.version = file.readString(11);
    patch.title = file.readString(256);
    patch.genre = file.readString(48);
    patch.language = file.readString(48);
    patch.date = file.readString(8);
    patch.web = file.readString(512);
    patch.description = file.readString(1074).replace(/\\n/g, "\n");

    file.seek(0x800);
    let nextFile: RupFile | null = null;
    while (!file.isEOF()) {
      const command = file.readU8();

      if (command === RUP_COMMAND_OPEN_NEW_FILE) {
        if (nextFile) patch.files.push(nextFile);

        nextFile = {
          fileName: file.readString(file.readVLV()),
          overflowData: [],
          overflowMode: null,
          records: [],
          romType: file.readU8(),
          sourceFileSize: file.readVLV(),
          sourceMD5: "",
          targetFileSize: file.readVLV(),
          targetMD5: "",
        };

        for (let i = 0; i < 16; i++) nextFile.sourceMD5 += RUP.padZeroes(file.readU8(), 1);
        for (let i = 0; i < 16; i++) nextFile.targetMD5 += RUP.padZeroes(file.readU8(), 1);

        if (nextFile.sourceFileSize !== nextFile.targetFileSize) {
          const overflowMode = file.readString(1);
          if (overflowMode !== "M" && overflowMode !== "A") throw new Error("RUP: invalid overflow mode");
          nextFile.overflowMode = overflowMode;
          nextFile.overflowData = file.readBytes(file.readVLV());
        }
      } else if (command === RUP_COMMAND_XOR_RECORD) {
        if (!nextFile) throw new Error("invalid RUP command");
        nextFile.records.push({
          offset: file.readVLV(),
          xor: file.readBytes(file.readVLV()),
        });
      } else if (command === RUP_COMMAND_END) {
        if (nextFile) patch.files.push(nextFile);
        break;
      } else {
        throw new Error("invalid RUP command");
      }
    }
    return patch;
  }

  static async buildFromRomsAsync(original: WritablePatchFile, modified: WritablePatchFile, description?: string) {
    const patch = new RUP();
    const today = new Date();
    patch.date = `${today.getFullYear()}${formatDatePart(today.getMonth() + 1)}${formatDatePart(today.getDate())}`;
    if (description) patch.description = description;

    const sourceMD5Promise = computeMD5(original);
    const targetMD5Promise = computeMD5(modified);

    const file: RupFile = {
      fileName: "",
      overflowData: [],
      overflowMode: null,
      records: [],
      romType: 0,
      sourceFileSize: original.fileSize,
      sourceMD5: "",
      targetFileSize: modified.fileSize,
      targetMD5: "",
    };

    if (file.sourceFileSize < file.targetFileSize) {
      modified.seek(file.sourceFileSize);
      file.overflowMode = "A";
      file.overflowData = modified.readBytes(file.targetFileSize - file.sourceFileSize).map((byte) => byte ^ 0xff);
      modified = modified.slice(0, file.sourceFileSize);
    } else if (file.sourceFileSize > file.targetFileSize) {
      original.seek(file.targetFileSize);
      file.overflowMode = "M";
      file.overflowData = original.readBytes(file.sourceFileSize - file.targetFileSize).map((byte) => byte ^ 0xff);
      original = original.slice(0, file.targetFileSize);
    }

    original.seek(0);
    modified.seek(0);

    while (!modified.isEOF()) {
      let b1 = original.isEOF() ? 0x00 : original.readU8();
      let b2 = modified.readU8();

      if (b1 !== b2) {
        const originalOffset = modified.offset - 1;
        const xorDifferences: number[] = [];

        while (b1 !== b2) {
          xorDifferences.push(b1 ^ b2);
          if (modified.isEOF()) break;
          b1 = original.isEOF() ? 0x00 : original.readU8();
          b2 = modified.readU8();
        }

        file.records.push({ offset: originalOffset, xor: xorDifferences });
      }
    }

    file.sourceMD5 = await sourceMD5Promise;
    file.targetMD5 = await targetMD5Promise;
    patch.files.push(file);

    return patch;
  }
}

function RUP_readVLV(this: WritablePatchFile) {
  const nBytes = this.readU8();
  var data = 0;
  for (let i = 0; i < nBytes; i++) data += this.readU8() << (i * 8);
  return data;
}

function RUP_writeVLV(this: WritablePatchFile, data: number) {
  var len = RUP_getVLVLen(data) - 1;
  this.writeU8(len);

  while (data) {
    this.writeU8(data & 0xff);
    data >>= 8;
  }
}

function RUP_getVLVLen(data: number) {
  var ret = 1;
  while (data) {
    ret++;
    data >>= 8;
  }
  return ret;
}

const exportRupPatch = function (this: RUP, fileName: string) {
  var patchFileSize = 2048;
  for (const file of this.files) {
    if (!file) continue;
    patchFileSize++;
    patchFileSize += RUP_getVLVLen(file.fileName.length);
    patchFileSize += file.fileName.length;
    patchFileSize++;
    patchFileSize += RUP_getVLVLen(file.sourceFileSize);
    patchFileSize += RUP_getVLVLen(file.targetFileSize);
    patchFileSize += 32;

    if (file.sourceFileSize !== file.targetFileSize) {
      patchFileSize++;
      patchFileSize += RUP_getVLVLen(file.overflowData.length);
      patchFileSize += file.overflowData.length;
    }
    for (const record of file.records) {
      if (!record) continue;
      patchFileSize++;
      patchFileSize += RUP_getVLVLen(record.offset);
      patchFileSize += RUP_getVLVLen(record.xor.length);
      patchFileSize += record.xor.length;
    }
  }
  patchFileSize++;

  const patchFile = new PatchPatchFile(patchFileSize) as WritablePatchFileWithVlv;
  patchFile.fileName = `${fileName}.rup`;
  patchFile.writeVLV = RUP_writeVLV;

  patchFile.writeString(RUP_MAGIC);
  patchFile.writeU8(this.textEncoding || 0);
  patchFile.writeString(this.author, 84);
  patchFile.writeString(this.version, 11);
  patchFile.writeString(this.title, 256);
  patchFile.writeString(this.genre, 48);
  patchFile.writeString(this.language, 48);
  patchFile.writeString(this.date, 8);
  patchFile.writeString(this.web, 512);
  patchFile.writeString(this.description.replace(/\n/g, "\\n"), 1074);

  for (const file of this.files) {
    if (!file) continue;
    patchFile.writeU8(RUP_COMMAND_OPEN_NEW_FILE);

    patchFile.writeVLV(file.fileName.length);
    patchFile.writeString(file.fileName);
    patchFile.writeU8(file.romType);
    patchFile.writeVLV(file.sourceFileSize);
    patchFile.writeVLV(file.targetFileSize);

    for (let j = 0; j < 16; j++) patchFile.writeU8(parseInt(file.sourceMD5.slice(j * 2, j * 2 + 2), 16));
    for (let j = 0; j < 16; j++) patchFile.writeU8(parseInt(file.targetMD5.slice(j * 2, j * 2 + 2), 16));

    if (file.sourceFileSize !== file.targetFileSize) {
      patchFile.writeString(file.sourceFileSize > file.targetFileSize ? "M" : "A");
      patchFile.writeVLV(file.overflowData.length);
      patchFile.writeBytes(file.overflowData);
    }

    for (const record of file.records) {
      if (!record) continue;
      patchFile.writeU8(RUP_COMMAND_XOR_RECORD);
      patchFile.writeVLV(record.offset);
      patchFile.writeVLV(record.xor.length);
      patchFile.writeBytes(record.xor);
    }
  }

  patchFile.writeU8(RUP_COMMAND_END);

  return patchFile;
};

const formatDatePart = (value: number) => RUP.padZeroes(value, 1);

export default RUP;
