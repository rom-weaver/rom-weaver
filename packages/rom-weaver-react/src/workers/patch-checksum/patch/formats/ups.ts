/* UPS module for RomWeaver v20240721 - Marc Robledo 2017-2024 - http://www.marcrobledo.com/license */
/* File format specification: http://www.romhacking.net/documents/392/ */

import type {
  PatchWritablePatchFile,
  PatchWritablePatchFileWithVlv,
  TypedPatchFileConstructor,
} from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { assertPatchValidation, createPatchedOutputFile } from "../patch-format-utils.ts";

const UPS_MAGIC = "UPS1";
type UpsRecord = {
  XORdata: number[];
  offset: number;
};

type WritablePatchFile = PatchWritablePatchFile<
  number[] | Uint8Array,
  {
    fileName?: string;
    _lastRead: number;
    littleEndian: boolean;
    readU32(): number;
    writeU32(value: number): void;
  }
>;

type WritablePatchFileWithVlv = PatchWritablePatchFileWithVlv<WritablePatchFile, "writeVLV">;

type ReadablePatchFileWithVlv = PatchWritablePatchFileWithVlv<WritablePatchFile, "readVLV">;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class UPS {
  static readonly MAGIC = UPS_MAGIC;

  checksumInput = 0;
  checksumOutput = 0;
  checksumPatch = 0;
  records: UpsRecord[] = [];
  sizeInput = 0;
  sizeOutput = 0;

  addRecord(relativeOffset: number, d: number[]) {
    this.records.push({ offset: relativeOffset, XORdata: d });
  }

  async apply(romFile: WritablePatchFile, validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    assertPatchValidation(validate, await this.validateSourceAsync(romFile), "Source ROM checksum mismatch");

    /* fix the glitch that cut the end of the file if it's larger than the changed file patch was originally created with */
    /* more info: https://github.com/marcrobledo/RomWeaver.js/pull/40#issuecomment-1069087423 */
    var sizeOutput = this.sizeOutput;
    var sizeInput = this.sizeInput;
    if (!validate && sizeInput < romFile.fileSize) {
      sizeInput = romFile.fileSize;
      if (sizeOutput < sizeInput) {
        sizeOutput = sizeInput;
      }
    }

    var tempFile = createPatchedOutputFile(
      PatchPatchFile,
      romFile,
      sizeOutput,
      applyOptions,
      sizeInput,
    ) as WritablePatchFile;

    romFile.seek(0);

    for (const record of this.records) {
      if (!record) continue;
      tempFile.skip(record.offset);
      romFile.skip(record.offset);

      for (const xorByte of record.XORdata) {
        tempFile.writeU8((romFile.isEOF() ? 0x00 : romFile.readU8()) ^ (xorByte ?? 0));
      }
      tempFile.skip(1);
      romFile.skip(1);
    }

    assertPatchValidation(
      validate,
      (await computeCRC32(tempFile)) === this.checksumOutput,
      "Target ROM checksum mismatch",
    );

    return tempFile;
  }

  async calculateFileChecksumAsync() {
    const patchFile = this.export("patch");
    return computeCRC32(patchFile, 0, patchFile.fileSize - 4);
  }

  export(fileName: string) {
    var patchFileSize = UPS_MAGIC.length; //UPS1 string
    patchFileSize += UPS_getVLVLength(this.sizeInput); //input file size
    patchFileSize += UPS_getVLVLength(this.sizeOutput); //output file size
    for (const record of this.records) {
      patchFileSize += UPS_getVLVLength(record.offset);
      patchFileSize += record.XORdata.length + 1;
    }
    patchFileSize += 12; //input/output/patch checksums

    var tempFile = new PatchPatchFile(patchFileSize) as WritablePatchFileWithVlv;
    tempFile.writeVLV = UPS_writeVLV;
    tempFile.fileName = `${fileName}.ups`;
    tempFile.writeString(UPS_MAGIC);

    tempFile.writeVLV(this.sizeInput);
    tempFile.writeVLV(this.sizeOutput);

    for (const record of this.records) {
      tempFile.writeVLV(record.offset);
      tempFile.writeBytes(record.XORdata);
      tempFile.writeU8(0x00);
    }
    tempFile.littleEndian = true;
    tempFile.writeU32(this.checksumInput);
    tempFile.writeU32(this.checksumOutput);
    tempFile.writeU32(this.checksumPatch);

    return tempFile;
  }

  getValidationInfo() {
    return {
      targetValue: this.checksumOutput,
      type: "CRC32",
      value: this.checksumInput,
    };
  }

  toString() {
    var s = `Records: ${this.records.length}`;
    s += `\nInput file size: ${this.sizeInput}`;
    s += `\nOutput file size: ${this.sizeOutput}`;
    s += `\nInput file checksum: ${this.checksumInput.toString(16)}`;
    s += `\nOutput file checksum: ${this.checksumOutput.toString(16)}`;
    return s;
  }

  async validateSourceAsync(romFile: WritablePatchFile, headerSize?: number) {
    return (await computeCRC32(romFile, headerSize)) === this.checksumInput;
  }

  static fromFile(file: WritablePatchFile) {
    var patch = new UPS();
    const fileWithVlv = file as ReadablePatchFileWithVlv;
    fileWithVlv.readVLV = UPS_readVLV;

    fileWithVlv.seek(UPS_MAGIC.length);

    patch.sizeInput = fileWithVlv.readVLV();
    patch.sizeOutput = fileWithVlv.readVLV();

    while (fileWithVlv.offset < fileWithVlv.fileSize - 12) {
      const relativeOffset = fileWithVlv.readVLV();

      const XORdifferences = [];
      while (fileWithVlv.readU8()) {
        XORdifferences.push(fileWithVlv._lastRead);
      }
      patch.addRecord(relativeOffset, XORdifferences);
    }

    fileWithVlv.littleEndian = true;
    patch.checksumInput = fileWithVlv.readU32();
    patch.checksumOutput = fileWithVlv.readU32();
    patch.checksumPatch = fileWithVlv.readU32();

    fileWithVlv.littleEndian = false;
    return patch;
  }

  static async fromFileAsync(file: WritablePatchFile) {
    const patch = UPS.fromFile(file);
    if (patch.checksumPatch !== (await computeCRC32(file, 0, file.fileSize - 4)))
      throw new Error("Patch checksum mismatch");
    return patch;
  }

  static async buildFromRomsAsync(original: WritablePatchFile, modified: WritablePatchFile) {
    var patch = new UPS();
    patch.sizeInput = original.fileSize;
    patch.sizeOutput = modified.fileSize;

    const checksumInputPromise = computeCRC32(original);
    const checksumOutputPromise = computeCRC32(modified);

    var previousSeek = 1;
    while (!modified.isEOF()) {
      let b1 = original.isEOF() ? 0x00 : original.readU8();
      let b2 = modified.readU8();

      if (b1 !== b2) {
        const currentSeek = modified.offset;
        const XORdata = [];

        while (b1 !== b2) {
          XORdata.push(b1 ^ b2);

          if (modified.isEOF()) break;
          b1 = original.isEOF() ? 0x00 : original.readU8();
          b2 = modified.readU8();
        }

        patch.addRecord(currentSeek - previousSeek, XORdata);
        previousSeek = currentSeek + XORdata.length + 1;
      }
    }

    patch.checksumInput = await checksumInputPromise;
    patch.checksumOutput = await checksumOutputPromise;
    patch.checksumPatch = await patch.calculateFileChecksumAsync();
    return patch;
  }
}

/* encode/decode variable length values, used by UPS file structure */
function UPS_writeVLV(this: WritablePatchFile, data: number) {
  for (;;) {
    const x = data & 0x7f;
    data = data >> 7;
    if (data === 0) {
      this.writeU8(0x80 | x);
      break;
    }
    this.writeU8(x);
    data = data - 1;
  }
}
function UPS_readVLV(this: WritablePatchFile) {
  var data = 0;

  var shift = 1;
  for (;;) {
    const x = this.readU8();

    if (x === -1) throw new Error(`Can't read UPS VLV at 0x${(this.offset - 1).toString(16)}`);

    data += (x & 0x7f) * shift;
    if ((x & 0x80) !== 0) break;
    shift = shift << 7;
    data += shift;
  }
  return data;
}
function UPS_getVLVLength(data: number) {
  var len = 0;
  for (;;) {
    data = data >> 7;
    len++;
    if (data === 0) {
      break;
    }
    data = data - 1;
  }
  return len;
}

export default UPS;
