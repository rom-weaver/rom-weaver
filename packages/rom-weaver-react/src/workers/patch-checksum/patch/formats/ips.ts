/* IPS module for Rom Patcher JS v20250430 - Marc Robledo 2016-2025 - http://www.marcrobledo.com/license */
/* File format specification: http://www.smwiki.net/wiki/IPS_file_format */

/* This file also acts as EBP (EarthBound Patch) module */
/* EBP is actually just IPS with some JSON metadata stuck on the end (implementation: https://github.com/Lyrositor/EBPatcher) */

import type { PatchWritablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { applyPatchRecords, resolveCreateOutputFile } from "../patch-format-utils.ts";

const IPS_MAGIC = "PATCH";
const IPS_MAX_ROM_SIZE = 0x1000000; //16 megabytes
const IPS_RECORD_RLE = 0x0000;
const IPS_RECORD_SIMPLE = 0x01;

type ByteSequence = Uint8Array | number[];
type EbpMetadata = Record<string, string>;

type IpsSimpleRecord = {
  data: ByteSequence;
  length: number;
  offset: number;
  type: typeof IPS_RECORD_SIMPLE;
};

type IpsRleRecord = {
  byte: number;
  length: number;
  offset: number;
  type: typeof IPS_RECORD_RLE;
};

type IpsRecord = IpsSimpleRecord | IpsRleRecord;
type MergeRecord = IpsSimpleRecord & {
  data: number[];
};

const isMergeRecord = (record: IpsRecord | undefined): record is MergeRecord =>
  !!record && record.type === IPS_RECORD_SIMPLE && Array.isArray(record.data);

type WritablePatchFile = Omit<
  PatchWritablePatchFile<
    ByteSequence,
    {
      readBytes(length: number): Uint8Array;
      readU16(): number;
      readU24(): number;
      readU8At(offset: number): number;
      slice(offset?: number, length?: number): WritablePatchFile;
      writeU16(value: number): void;
      writeU24(value: number): void;
    }
  >,
  "readBytes" | "slice"
> & {
  readBytes(length: number): Uint8Array;
  slice(offset?: number, length?: number): WritablePatchFile;
};

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class IPS {
  static readonly MAGIC = IPS_MAGIC;

  EBPmetadata: EbpMetadata | null = null;
  records: IpsRecord[] = [];
  truncate: false | number = false;

  addRLERecord(o: number, l: number, b: number) {
    this.records.push({ byte: b, length: l, offset: o, type: IPS_RECORD_RLE });
  }

  addSimpleRecord(o: number, d: ByteSequence) {
    this.records.push({ data: d, length: d.length, offset: o, type: IPS_RECORD_SIMPLE });
  }

  apply(romFile: WritablePatchFile, _validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    const createOutputFile = resolveCreateOutputFile(PatchPatchFile, applyOptions) as (
      size: number,
    ) => WritablePatchFile;
    let tempFile: WritablePatchFile;
    if (this.truncate && !this.EBPmetadata) {
      if (this.truncate > romFile.fileSize) {
        //expand (discussed here: https://github.com/marcrobledo/RomWeaver.js/pull/46)
        tempFile = createOutputFile(this.truncate);
        romFile.copyTo(tempFile, 0, romFile.fileSize, 0);
      } else {
        //truncate
        tempFile = createOutputFile(this.truncate);
        romFile.copyTo(tempFile, 0, this.truncate, 0);
      }
    } else {
      //calculate target ROM size, expanding it if any record offset is beyond target ROM size
      let newFileSize = romFile.fileSize;
      for (const rec of this.records) {
        if (rec.type === IPS_RECORD_RLE) {
          if (rec.offset + rec.length > newFileSize) {
            newFileSize = rec.offset + rec.length;
          }
        } else if (rec.offset + rec.data.length > newFileSize) {
          newFileSize = rec.offset + rec.data.length;
        }
      }

      if (newFileSize === romFile.fileSize) {
        tempFile = createOutputFile(romFile.fileSize);
        romFile.copyTo(tempFile, 0, romFile.fileSize, 0);
      } else {
        tempFile = createOutputFile(newFileSize);
        romFile.copyTo(tempFile, 0);
      }
    }

    romFile.seek(0);

    applyPatchRecords(
      tempFile,
      this.records.map((record) =>
        record.type === IPS_RECORD_RLE
          ? { byte: record.byte, length: record.length, offset: record.offset, type: record.type }
          : { data: Uint8Array.from(record.data), offset: record.offset, type: record.type },
      ),
      IPS_RECORD_RLE,
    );

    return tempFile;
  }

  export(fileName: string) {
    var patchFileSize = 5; //PATCH string
    for (const record of this.records) {
      if (record.type === IPS_RECORD_RLE)
        patchFileSize += 3 + 2 + 2 + 1; //offset+0x0000+length+RLE byte to be written
      else patchFileSize += 3 + 2 + record.data.length; //offset+length+data
    }
    patchFileSize += 3; //EOF string
    if (this.truncate && !this.EBPmetadata)
      patchFileSize += 3; //truncate
    else if (this.EBPmetadata) patchFileSize += JSON.stringify(this.EBPmetadata).length;

    var tempFile = new PatchPatchFile(patchFileSize);
    tempFile.fileName = fileName + (this.EBPmetadata ? ".ebp" : ".ips");
    tempFile.writeString(IPS_MAGIC);
    for (const rec of this.records) {
      tempFile.writeU24(rec.offset);
      if (rec.type === IPS_RECORD_RLE) {
        tempFile.writeU16(0x0000);
        tempFile.writeU16(rec.length);
        tempFile.writeU8(rec.byte);
      } else {
        tempFile.writeU16(rec.data.length);
        tempFile.writeBytes(rec.data);
      }
    }

    tempFile.writeString("EOF");
    if (this.truncate && !this.EBPmetadata) tempFile.writeU24(this.truncate);
    else if (this.EBPmetadata) tempFile.writeString(JSON.stringify(this.EBPmetadata));

    return tempFile;
  }

  getDescription() {
    if (this.EBPmetadata) {
      let description = "";
      for (const key in this.EBPmetadata) {
        if (key === "patcher") continue;

        const keyPretty = key.charAt(0).toUpperCase() + key.slice(1);
        description += `${keyPretty}: ${this.EBPmetadata[key]}\n`;
      }
      return description.trim();
    }
    return null;
  }

  setEBPMetadata(metadataObject: EbpMetadata) {
    if (typeof metadataObject !== "object") throw new TypeError("metadataObject must be an object");
    for (const key in metadataObject) {
      if (typeof metadataObject[key] !== "string") throw new TypeError("metadataObject values must be strings");
    }

    /* EBPatcher (linked above) expects the "patcher" field to be EBPatcher to read the metadata */
    /* CoilSnake (EB modding tool) inserts this manually too */
    /* So we also add it here for compatibility purposes */
    this.EBPmetadata = { patcher: "EBPatcher", ...metadataObject };
  }

  toString() {
    var nSimpleRecords = 0;
    var nRLERecords = 0;
    for (const record of this.records) {
      if (record.type === IPS_RECORD_RLE) nRLERecords++;
      else nSimpleRecords++;
    }
    var s = `Simple records: ${nSimpleRecords}`;
    s += `\nRLE records: ${nRLERecords}`;
    s += `\nTotal records: ${this.records.length}`;
    if (this.truncate && !this.EBPmetadata) s += `\nTruncate at: 0x${this.truncate.toString(16)}`;
    else if (this.EBPmetadata) s += `\nEBP Metadata: ${JSON.stringify(this.EBPmetadata)}`;
    return s;
  }

  static fromFile(file: WritablePatchFile) {
    var patchFile = new IPS();
    file.seek(5);

    while (!file.isEOF()) {
      const offset = file.readU24();

      if (offset === 0x454f46) {
        /* EOF */
        if (file.isEOF()) {
          break;
        }
        if (file.offset + 3 === file.fileSize) {
          patchFile.truncate = file.readU24();
          break;
        }
        if (file.readU8() === "{".charCodeAt(0)) {
          file.skip(-1);
          patchFile.setEBPMetadata(JSON.parse(file.readString(file.fileSize - file.offset)) as EbpMetadata);
          break;
        }
      }

      const length = file.readU16();

      if (length === IPS_RECORD_RLE) {
        patchFile.addRLERecord(offset, file.readU16(), file.readU8());
      } else {
        patchFile.addSimpleRecord(offset, file.readBytes(length));
      }
    }
    return patchFile;
  }

  static buildFromRoms(original: WritablePatchFile, modified: WritablePatchFile, asEBP: boolean | EbpMetadata = false) {
    var patch = new IPS();

    if (!asEBP && modified.fileSize < original.fileSize) {
      patch.truncate = modified.fileSize;
    } else if (asEBP) {
      patch.setEBPMetadata(
        typeof asEBP === "object"
          ? asEBP
          : {
              Author: "Unknown",
              Description: "No description",
              Title: "Untitled",
            },
      );
    }

    //solucion: guardar startOffset y endOffset (ir mirando de 6 en 6 hacia atrás)
    var previousRecord: MergeRecord | null = null;
    while (!modified.isEOF()) {
      let b1 = original.isEOF() ? 0x00 : original.readU8();
      let b2 = modified.readU8();

      if (b1 !== b2) {
        let RLEmode = true;
        const differentData = [];
        const startOffset = modified.offset - 1;

        while (b1 !== b2 && differentData.length < 0xffff) {
          differentData.push(b2);
          if (b2 !== differentData[0]) RLEmode = false;

          if (modified.isEOF() || differentData.length === 0xffff) break;

          b1 = original.isEOF() ? 0x00 : original.readU8();
          b2 = modified.readU8();
        }

        //check if this record is near the previous one
        const previousRecordEnd = previousRecord ? previousRecord.offset + previousRecord.length : 0;
        let distance = startOffset - previousRecordEnd;
        if (previousRecord && distance < 6 && previousRecord.length + distance + differentData.length < 0xffff) {
          if (RLEmode && differentData.length > 6) {
            // separate a potential RLE record
            original.seek(startOffset);
            modified.seek(startOffset);
            previousRecord = null;
          } else {
            // merge both records
            while (distance--) {
              previousRecord.data.push(modified.readU8At(previousRecord.offset + previousRecord.length));
              previousRecord.length++;
            }
            previousRecord.data = previousRecord.data.concat(differentData);
            previousRecord.length = previousRecord.data.length;
          }
        } else {
          if (startOffset >= IPS_MAX_ROM_SIZE) {
            throw new Error(`Files are too big for ${patch.EBPmetadata ? "EBP" : "IPS"} format`);
          }

          if (RLEmode && differentData.length > 2) {
            patch.addRLERecord(startOffset, differentData.length, differentData[0] || 0);
          } else {
            patch.addSimpleRecord(startOffset, differentData);
          }
          const latestRecord = patch.records.at(-1);
          previousRecord = isMergeRecord(latestRecord) ? latestRecord : null;
        }
      }
    }

    if (modified.fileSize > original.fileSize) {
      const lastRecord = patch.records.at(-1);
      const lastOffset = lastRecord ? lastRecord.offset + lastRecord.length : 0;

      if (lastOffset < modified.fileSize) {
        patch.addSimpleRecord(modified.fileSize - 1, [0x00]);
      }
    }

    return patch;
  }
}

export default IPS;
