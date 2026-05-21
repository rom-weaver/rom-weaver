/* PMSR (Paper Mario Star Rod) module for RomWeaver v20240721 - Marc Robledo 2020-2024 - http://www.marcrobledo.com/license */
/* File format specification: http://origami64.net/attachment.php?aid=790 (dead link) */

import type { PatchWritablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { assertPatchValidation, createPatchedOutputFile } from "../patch-format-utils.ts";

const PMSR_MAGIC = "PMSR";
const _YAY0_MAGIC = "Yay0";
const PAPER_MARIO_USA10_CRC32 = 0xa7f5cd7e;
const PAPER_MARIO_USA10_FILE_SIZE = 41943040;

type PatchRecord = {
  data: Uint8Array;
  offset: number;
};

type WritablePatchFile = PatchWritablePatchFile<
  Uint8Array,
  {
    readU32(): number;
  }
>;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class PMSR {
  static readonly MAGIC = PMSR_MAGIC;

  records: PatchRecord[] = [];
  targetSize = 0;

  addRecord(offset: number, data: Uint8Array) {
    this.records.push({ data: data, offset: offset });
  }

  async apply(romFile: WritablePatchFile, validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    assertPatchValidation(validate, await this.validateSourceAsync(romFile), "Source ROM checksum mismatch");

    let tempFile: PatchWritablePatchFile<Uint8Array>;
    if (this.targetSize === romFile.fileSize && !applyOptions) {
      tempFile = romFile.slice(0, romFile.fileSize);
    } else {
      tempFile = createPatchedOutputFile(PatchPatchFile, romFile, this.targetSize, applyOptions) as WritablePatchFile;
    }

    for (const record of this.records) {
      if (!record) continue;
      tempFile.seek(record.offset);
      tempFile.writeBytes(record.data);
    }

    return tempFile;
  }

  getValidationInfo(): { type: string; value: number } {
    return {
      type: "CRC32",
      value: PAPER_MARIO_USA10_CRC32,
    };
  }

  toString(): string {
    var s = "Star Rod patch";
    s += `\nTarget file size: ${this.targetSize}`;
    s += `\n#Records: ${this.records.length}`;
    return s;
  }

  async validateSourceAsync(romFile: WritablePatchFile): Promise<boolean> {
    return (
      romFile.fileSize === PAPER_MARIO_USA10_FILE_SIZE && (await computeCRC32(romFile)) === PAPER_MARIO_USA10_CRC32
    );
  }

  static fromFile(file: WritablePatchFile) {
    var patch = new PMSR();

    /*file.seek(0);
	if(file.readString(YAY0_MAGIC.length)===YAY0_MAGIC){
		file=PMSR.YAY0_decode(file);
	}*/
    void _YAY0_MAGIC;

    patch.targetSize = PAPER_MARIO_USA10_FILE_SIZE;

    file.seek(4);
    var nRecords = file.readU32();

    for (let i = 0; i < nRecords; i++) {
      const offset = file.readU32();
      const length = file.readU32();
      patch.addRecord(offset, file.readBytes(length));

      if (offset + length > patch.targetSize) patch.targetSize = offset + length;
    }

    return patch;
  }

  /* https://github.com/pho/WindViewer/wiki/Yaz0-and-Yay0 */
  static YAY0_decode(_file: WritablePatchFile) {
    /* to-do */
  }
}

/* to-do */
//PMSR.buildFromRoms=function(original, modified){return null}

export default PMSR;
