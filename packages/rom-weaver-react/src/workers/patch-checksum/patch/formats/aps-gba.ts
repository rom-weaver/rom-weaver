/* APS (GBA) module for Rom Patcher JS v20230331 - Marc Robledo 2017-2023 - http://www.marcrobledo.com/license */
/* File format specification: https://github.com/btimofeev/UniPatcher/wiki/APS-(GBA) */

import type { PatchWritablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { assertPatchValidation, createPatchedOutputFile } from "../patch-format-utils.ts";

const APS_GBA_MAGIC = "APS1";
const APS_GBA_BLOCK_SIZE = 0x010000; //64Kb
const APS_GBA_RECORD_SIZE = 4 + 2 + 2 + APS_GBA_BLOCK_SIZE;
const CRC16_POLYNOMIAL = 0x1021;

type ApsGbaRecord = {
  offset: number;
  sourceCrc16: number;
  targetCrc16: number;
  xorBytes: Uint8Array;
};

type WritablePatchFile = PatchWritablePatchFile<
  Uint8Array,
  {
    littleEndian: boolean;
    readU16(): number;
    readU32(): number;
    writeU16(value: number): void;
    writeU32(value: number): void;
  }
>;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class APSGBA {
  static readonly MAGIC = APS_GBA_MAGIC;

  records: ApsGbaRecord[] = [];
  sourceSize = 0;
  targetSize = 0;

  addRecord(offset: number, sourceCrc16: number, targetCrc16: number, xorBytes: Uint8Array) {
    this.records.push({
      offset: offset,
      sourceCrc16: sourceCrc16,
      targetCrc16: targetCrc16,
      xorBytes: xorBytes,
    });
  }

  async apply(romFile: WritablePatchFile, validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    assertPatchValidation(validate, await this.validateSourceAsync(romFile), "Source ROM checksum mismatch");

    var tempFile = createPatchedOutputFile(PatchPatchFile, romFile, this.targetSize, applyOptions) as WritablePatchFile;

    for (const record of this.records) {
      romFile.seek(record.offset);
      tempFile.seek(record.offset);
      for (let j = 0; j < APS_GBA_BLOCK_SIZE; j++) {
        tempFile.writeU8(romFile.readU8() ^ (record.xorBytes[j] ?? 0));
      }

      assertPatchValidation(
        validate,
        calculateFileCrc16(tempFile, record.offset, APS_GBA_BLOCK_SIZE) === record.targetCrc16,
        "Target ROM checksum mismatch",
      );
    }

    return tempFile;
  }

  export(fileName: string) {
    var patchFileSize = 12 + this.records.length * APS_GBA_RECORD_SIZE;

    var tempFile = new PatchPatchFile(patchFileSize);
    tempFile.littleEndian = true;
    tempFile.fileName = `${fileName}.aps`;
    tempFile.writeString(APS_GBA_MAGIC, APS_GBA_MAGIC.length);
    tempFile.writeU32(this.sourceSize);
    tempFile.writeU32(this.targetSize);

    for (const record of this.records) {
      tempFile.writeU32(record.offset);
      tempFile.writeU16(record.sourceCrc16);
      tempFile.writeU16(record.targetCrc16);
      tempFile.writeBytes(record.xorBytes);
    }

    return tempFile;
  }

  getValidationInfo() {
    const blockCount = `${this.records.length} blocks`;
    return {
      targetValue: blockCount,
      type: "CRC16",
      value: blockCount,
    };
  }

  toString() {
    var s = `Total records: ${this.records.length}`;
    s += `\nInput file size: ${this.sourceSize}`;
    s += `\nOutput file size: ${this.targetSize}`;
    return s;
  }

  async validateSourceAsync(sourceFile: WritablePatchFile) {
    if (sourceFile.fileSize !== this.sourceSize) return false;

    for (const record of this.records) {
      if (calculateFileCrc16(sourceFile, record.offset, APS_GBA_BLOCK_SIZE) !== record.sourceCrc16) return false;
    }

    return true;
  }

  static fromFile(patchFile: WritablePatchFile) {
    patchFile.seek(0);
    patchFile.littleEndian = true;

    if (
      patchFile.readString(APS_GBA_MAGIC.length) !== APS_GBA_MAGIC ||
      patchFile.fileSize < 12 + APS_GBA_RECORD_SIZE ||
      (patchFile.fileSize - 12) % APS_GBA_RECORD_SIZE !== 0
    )
      return null;

    var patch = new APSGBA();

    patch.sourceSize = patchFile.readU32();
    patch.targetSize = patchFile.readU32();

    while (!patchFile.isEOF()) {
      const offset = patchFile.readU32();
      const sourceCrc16 = patchFile.readU16();
      const targetCrc16 = patchFile.readU16();
      const xorBytes = patchFile.readBytes(APS_GBA_BLOCK_SIZE);

      patch.addRecord(offset, sourceCrc16, targetCrc16, xorBytes);
    }
    return patch;
  }
}

const calculateCrc16 = (bytes: ArrayLike<number>) => {
  let crc = 0xffff;
  for (const value of Array.from(bytes)) {
    crc ^= (value ?? 0) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ CRC16_POLYNOMIAL : crc << 1;
  }
  return crc & 0xffff;
};

const calculateFileCrc16 = (file: WritablePatchFile, offset: number, length: number) => {
  file.seek(offset);
  return calculateCrc16(file.readBytes(length));
};

export default APSGBA;
