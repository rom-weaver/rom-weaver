const V64_EXTENSION_REGEX = /\.v64$/i;

/* APS (N64) module for Rom Patcher JS v20180930 - Marc Robledo 2017-2018 - http://www.marcrobledo.com/license */
/* File format specification: https://github.com/btimofeev/UniPatcher/wiki/APS-(N64) */

import type { PatchWritablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { applyPatchRecords, assertPatchValidation, createPatchedOutputFile } from "../patch-format-utils.ts";

const APS_N64_MAGIC = "APS10";
const APS_RECORD_RLE = 0x0000;
const APS_RECORD_SIMPLE = 0x01;
const APS_N64_MODE = 0x01;

type ApsSimpleRecord = {
  data: number[] | Uint8Array;
  offset: number;
  type: typeof APS_RECORD_SIMPLE;
};

type ApsRleRecord = {
  byte: number;
  length: number;
  offset: number;
  type: typeof APS_RECORD_RLE;
};

type ApsRecord = ApsSimpleRecord | ApsRleRecord;

type ApsHeader = {
  cartId?: string;
  crc?: Uint8Array;
  originalN64Format?: number;
  pad?: number[] | Uint8Array;
  sizeOutput?: number;
};

type WritablePatchFile = Omit<
  PatchWritablePatchFile<
    number[] | Uint8Array,
    {
      littleEndian: boolean;
      readBytes(length: number): Uint8Array;
      readU32(): number;
      writeU32(value: number): void;
    }
  >,
  "readBytes"
> & {
  readBytes(length: number): Uint8Array;
};

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class APS {
  static readonly MAGIC = APS_N64_MAGIC;

  description = "no description";
  encodingMethod = 0;
  header: ApsHeader = {};
  headerType = 0;
  records: ApsRecord[] = [];

  addRecord(o: number, d: number[] | Uint8Array) {
    this.records.push({ data: d, offset: o, type: APS_RECORD_SIMPLE });
  }

  addRLERecord(o: number, b: number, l: number) {
    this.records.push({ byte: b, length: l, offset: o, type: APS_RECORD_RLE });
  }

  async apply(romFile: WritablePatchFile, validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    assertPatchValidation(validate, await this.validateSourceAsync(romFile), "Source ROM checksum mismatch");

    var tempFile = createPatchedOutputFile(
      PatchPatchFile,
      romFile,
      this.header.sizeOutput || 0,
      applyOptions,
      Math.min(romFile.fileSize, this.header.sizeOutput || 0),
    ) as WritablePatchFile;

    applyPatchRecords(
      tempFile,
      this.records.map((record) =>
        record.type === APS_RECORD_RLE
          ? { byte: record.byte, length: record.length, offset: record.offset, type: record.type }
          : { data: Uint8Array.from(record.data), offset: record.offset, type: record.type },
      ),
      APS_RECORD_RLE,
    );

    return tempFile;
  }

  export(fileName: string) {
    var patchFileSize = 61;
    if (this.headerType === APS_N64_MODE) patchFileSize += 17;

    for (const record of this.records) {
      if (record.type === APS_RECORD_RLE) patchFileSize += 7;
      else patchFileSize += 5 + record.data.length; //offset+length+data
    }

    var tempFile = new PatchPatchFile(patchFileSize);
    tempFile.littleEndian = true;
    tempFile.fileName = `${fileName}.aps`;
    tempFile.writeString(APS_N64_MAGIC, APS_N64_MAGIC.length);
    tempFile.writeU8(this.headerType);
    tempFile.writeU8(this.encodingMethod);
    tempFile.writeString(this.description, 50);

    if (this.headerType === APS_N64_MODE) {
      tempFile.writeU8(this.header.originalN64Format || 0);
      tempFile.writeString(this.header.cartId || "", 3);
      tempFile.writeBytes(this.header.crc || new Uint8Array(8));
      tempFile.writeBytes(this.header.pad || [0, 0, 0, 0, 0]);
    }
    tempFile.writeU32(this.header.sizeOutput || 0);

    for (const rec of this.records) {
      tempFile.writeU32(rec.offset);
      if (rec.type === APS_RECORD_RLE) {
        tempFile.writeU8(0x00);
        tempFile.writeU8(rec.byte);
        tempFile.writeU8(rec.length);
      } else {
        tempFile.writeU8(rec.data.length);
        tempFile.writeBytes(rec.data);
      }
    }

    return tempFile;
  }

  getValidationInfo() {
    if (this.headerType === APS_N64_MODE) {
      const crcBytes = Array.from(this.header.crc || []);
      return `${this.header.cartId} (${crcBytes.reduce((hex: string, b: number) => {
        if (b < 16) return `${hex}0${b.toString(16)}`;
        return hex + b.toString(16);
      }, "")})`;
    }
    return null;
  }

  toString() {
    var s = `Total records: ${this.records.length}`;
    s += `\nHeader type: ${this.headerType}`;
    if (this.headerType === APS_N64_MODE) {
      s += " (N64)";
    }
    s += `\nEncoding method: ${this.encodingMethod}`;
    s += `\nDescription: ${this.description}`;
    s += `\nHeader: ${JSON.stringify(this.header)}`;
    return s;
  }

  async validateSourceAsync(sourceFile: WritablePatchFile) {
    if (this.headerType === APS_N64_MODE) {
      sourceFile.seek(0x3c);
      if (sourceFile.readString(3) !== this.header.cartId) return false;

      sourceFile.seek(0x10);
      const crc = sourceFile.readBytes(8);
      for (let i = 0; i < 8; i++) {
        if (crc[i] !== this.header.crc?.[i]) return false;
      }
    }
    return true;
  }

  static fromFile(patchFile: WritablePatchFile) {
    var patch = new APS();
    patchFile.littleEndian = true;

    patchFile.seek(5);
    patch.headerType = patchFile.readU8();
    patch.encodingMethod = patchFile.readU8();
    patch.description = patchFile.readString(50);

    if (patch.headerType === APS_N64_MODE) {
      patch.header.originalN64Format = patchFile.readU8();
      patch.header.cartId = patchFile.readString(3);
      patch.header.crc = patchFile.readBytes(8);
      patch.header.pad = patchFile.readBytes(5);
    }
    patch.header.sizeOutput = patchFile.readU32();

    while (!patchFile.isEOF()) {
      const offset = patchFile.readU32();
      const length = patchFile.readU8();

      if (length === APS_RECORD_RLE) patch.addRLERecord(offset, patchFile.readU8(), patchFile.readU8());
      else patch.addRecord(offset, patchFile.readBytes(length));
    }
    return patch;
  }

  static buildFromRoms(original: WritablePatchFile, modified: WritablePatchFile) {
    var patch = new APS();

    if (original.readU32() === 0x80371240) {
      //is N64 ROM
      patch.headerType = APS_N64_MODE;

      patch.header.originalN64Format = V64_EXTENSION_REGEX.test(original.fileName) ? 0 : 1;
      original.seek(0x3c);
      patch.header.cartId = original.readString(3);
      original.seek(0x10);
      patch.header.crc = original.readBytes(8);
      patch.header.pad = [0, 0, 0, 0, 0];
    }
    patch.header.sizeOutput = modified.fileSize;

    original.seek(0);
    modified.seek(0);

    while (!modified.isEOF()) {
      let b1 = original.isEOF() ? 0x00 : original.readU8();
      let b2 = modified.readU8();

      if (b1 !== b2) {
        let RLERecord = true;
        const differentBytes = [];
        const offset = modified.offset - 1;

        while (b1 !== b2 && differentBytes.length < 0xff) {
          differentBytes.push(b2);
          if (b2 !== differentBytes[0]) RLERecord = false;

          if (modified.isEOF() || differentBytes.length === 0xff) break;

          b1 = original.isEOF() ? 0x00 : original.readU8();
          b2 = modified.readU8();
        }

        if (RLERecord && differentBytes.length > 2) {
          patch.addRLERecord(offset, differentBytes[0] || 0, differentBytes.length);
        } else {
          patch.addRecord(offset, differentBytes);
        }
      }
    }

    return patch;
  }
}

export default APS;
