const TRAILING_SPACE_REGEX = / +$/;

/* PPF module for Rom Patcher JS v20200221 - Marc Robledo 2019-2020 - http://www.marcrobledo.com/license */
/* File format specification: https://www.romhacking.net/utilities/353/  */

import type { PatchWritablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { resolveCreateOutputFile } from "../patch-format-utils.ts";

const PPF_MAGIC = "PPF";
const PPF_IMAGETYPE_BIN = 0x00;
const _PPF_IMAGETYPE_GI = 0x01;
const PPF_BEGIN_FILE_ID_DIZ_MAGIC = "@BEG"; //@BEGIN_FILE_ID.DIZ

type PpfRecord = {
  data: number[] | Uint8Array;
  offset: number;
  undoData?: number[] | Uint8Array;
};

type WritablePatchFile = PatchWritablePatchFile<
  number[] | Uint8Array,
  {
    description?: string;
    littleEndian: boolean;
    readU32(): number;
    slice(offset?: number, length?: number): WritablePatchFile;
    writeU16(value: number): void;
    writeU32(value: number): void;
  }
>;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

void _PPF_IMAGETYPE_GI;

class PPF {
  static readonly MAGIC = PPF_MAGIC;

  blockCheck: boolean | Uint8Array = false;
  description = "";
  fileIdDiz?: string;
  imageType = PPF_IMAGETYPE_BIN;
  inputFileSize?: number;
  records: PpfRecord[] = [];
  undoData = false;
  version = 3;

  addRecord(offset: number, data: number[] | Uint8Array, undoData?: number[] | Uint8Array) {
    if (this.undoData) {
      this.records.push({ data: data, offset: offset, undoData: undoData });
    } else {
      this.records.push({ data: data, offset: offset });
    }
  }

  apply(romFile: WritablePatchFile, _validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    const createOutputFile = resolveCreateOutputFile(PatchPatchFile, applyOptions) as (
      size: number,
    ) => WritablePatchFile;
    var newFileSize = romFile.fileSize;
    for (const record of this.records) {
      if (record.offset + record.data.length > newFileSize) newFileSize = record.offset + record.data.length;
    }
    let tempFile: PatchWritablePatchFile<number[] | Uint8Array>;
    if (newFileSize === romFile.fileSize && !applyOptions) {
      tempFile = romFile.slice(0, romFile.fileSize);
    } else {
      tempFile = createOutputFile(newFileSize);
      romFile.copyTo(tempFile, 0);
    }

    //check if undoing
    var undoingData = false;
    if (this.undoData) {
      const firstRecord = this.records[0];
      if (!firstRecord) return tempFile;
      tempFile.seek(firstRecord.offset);
      const originalBytes = tempFile.readBytes(firstRecord.data.length);
      let foundDifferences = false;
      for (let i = 0; i < originalBytes.length && !foundDifferences; i++) {
        if (originalBytes[i] !== firstRecord.data[i]) {
          foundDifferences = true;
        }
      }
      if (!foundDifferences) {
        undoingData = true;
      }
    }

    for (const record of this.records) {
      if (!record) continue;
      tempFile.seek(record.offset);

      if (undoingData) {
        tempFile.writeBytes(record.undoData || []);
      } else {
        tempFile.writeBytes(record.data);
      }
    }

    return tempFile;
  }

  export(fileName: string) {
    var patchFileSize = 5 + 1 + 50; //PPFx0
    for (const record of this.records) {
      patchFileSize += 4 + 1 + record.data.length;
      if (this.version === 3) patchFileSize += 4; //offsets are u64
    }

    if (this.version === 3 || this.version === 2) {
      patchFileSize += 4;
    }
    if (this.blockCheck) {
      patchFileSize += 1024;
    }
    if (this.fileIdDiz) {
      patchFileSize += 18 + this.fileIdDiz.length + 16 + 4;
    }

    var tempFile = new PatchPatchFile(patchFileSize);
    tempFile.fileName = `${fileName}.ppf`;
    tempFile.writeString(PPF_MAGIC);
    tempFile.writeString((this.version * 10).toString());
    tempFile.writeU8(this.version - 1);
    tempFile.writeString(this.description, 50);

    if (this.version === 3) {
      tempFile.writeU8(this.imageType);
      tempFile.writeU8(this.blockCheck ? 0x01 : 0x00);
      tempFile.writeU8(this.undoData ? 0x01 : 0x00);
      tempFile.writeU8(0x00); //dummy
    } else if (this.version === 2) {
      tempFile.writeU32(this.inputFileSize ?? 0);
    }

    if (this.blockCheck instanceof Uint8Array) {
      tempFile.writeBytes(this.blockCheck);
    }

    tempFile.littleEndian = true;
    for (const record of this.records) {
      tempFile.writeU32(record.offset & 0xffffffff);

      if (this.version === 3) {
        let offset2 = record.offset;
        for (let j = 0; j < 32; j++) offset2 = (offset2 / 2) >>> 0;
        tempFile.writeU32(offset2);
      }
      tempFile.writeU8(record.data.length);
      tempFile.writeBytes(record.data);
      if (this.undoData && record.undoData) tempFile.writeBytes(record.undoData);
    }

    if (this.fileIdDiz) {
      tempFile.writeString("@BEGIN_FILE_ID.DIZ");
      tempFile.writeString(this.fileIdDiz);
      tempFile.writeString("@END_FILE_ID.DIZ");
      tempFile.writeU16(this.fileIdDiz.length);
      tempFile.writeU16(0x00);
    }

    return tempFile;
  }

  toString() {
    var s = this.description;
    s += `\nPPF version: ${this.version}`;
    s += `\n#Records: ${this.records.length}`;
    s += `\nImage type: ${this.imageType}`;
    s += `\nBlock check: ${!!this.blockCheck}`;
    s += `\nUndo data: ${this.undoData}`;
    if (this.fileIdDiz) s += `\nFILE_ID.DIZ: ${this.fileIdDiz}`;
    return s;
  }

  static fromFile(patchFile: WritablePatchFile) {
    var patch = new PPF();

    patchFile.seek(3);
    var version1 = parseInt(patchFile.readString(2), 10) / 10;
    var version2 = patchFile.readU8() + 1;
    if (version1 !== version2 || version1 > 3) {
      throw new Error("invalid PPF version");
    }

    patch.version = version1;
    patch.description = patchFile.readString(50).replace(TRAILING_SPACE_REGEX, "");

    if (patch.version === 3) {
      patch.imageType = patchFile.readU8();
      if (patchFile.readU8()) patch.blockCheck = true;
      if (patchFile.readU8()) patch.undoData = true;

      patchFile.skip(1);
    } else if (patch.version === 2) {
      patch.blockCheck = true;
      patch.inputFileSize = patchFile.readU32();
    }

    if (patch.blockCheck) {
      const blockCheck = patchFile.readBytes(1024);
      patch.blockCheck = blockCheck instanceof Uint8Array ? blockCheck : Uint8Array.from(blockCheck);
    }

    patchFile.littleEndian = true;
    while (!patchFile.isEOF()) {
      if (patchFile.readString(4) === PPF_BEGIN_FILE_ID_DIZ_MAGIC) {
        patchFile.skip(14);
        // found file_id.diz begin
        patch.fileIdDiz = patchFile.readString(3072);
        patch.fileIdDiz = patch.fileIdDiz.slice(0, patch.fileIdDiz.indexOf("@END_FILE_ID.DIZ"));
        break;
      }
      patchFile.skip(-4);

      let offset: number;
      if (patch.version === 3) {
        const u64_1 = patchFile.readU32();
        const u64_2 = patchFile.readU32();
        offset = u64_1 + u64_2 * 0x100000000;
      } else offset = patchFile.readU32();

      const len = patchFile.readU8();
      const data = patchFile.readBytes(len);

      let undoData: number[] | Uint8Array | undefined;
      if (patch.undoData) {
        undoData = patchFile.readBytes(len);
      }

      patch.addRecord(offset, data, undoData);
    }

    return patch;
  }

  static buildFromRoms(original: WritablePatchFile, modified: WritablePatchFile) {
    var patch = new PPF();

    patch.description = "Patch description";

    if (original.fileSize > modified.fileSize) {
      const expandedModified = new PatchPatchFile(original.fileSize);
      modified.copyTo(expandedModified, 0);
      modified = expandedModified;
    }

    original.seek(0);
    modified.seek(0);
    while (!modified.isEOF()) {
      let b1 = original.isEOF() ? 0x00 : original.readU8();
      let b2 = modified.readU8();

      if (b1 !== b2) {
        const differentData = [];
        const offset = modified.offset - 1;

        while (b1 !== b2 && differentData.length < 0xff) {
          differentData.push(b2);

          if (modified.isEOF() || differentData.length === 0xff) break;

          b1 = original.isEOF() ? 0x00 : original.readU8();
          b2 = modified.readU8();
        }

        patch.addRecord(offset, differentData);
      }
    }

    if (original.fileSize < modified.fileSize) {
      modified.seek(modified.fileSize - 1);
      if (modified.readU8() === 0x00) patch.addRecord(modified.fileSize - 1, [0x00]);
    }

    return patch;
  }
}

export default PPF;
