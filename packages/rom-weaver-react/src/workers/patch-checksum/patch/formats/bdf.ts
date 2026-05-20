/* BDF module for Rom Patcher JS v20250922 - Marc Robledo 2025 - http://www.marcrobledo.com/license */
/* File format specification: https://www.daemonology.net/bsdiff/ */

import bz2 from "../../../../../vendor/bz2.js";
import type { PatchReadablePatchFile, TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { resolveCreateOutputFile } from "../patch-format-utils.ts";

const BDF_MAGIC = "BSDIFF40";

type BdfRecord = {
  diff: Uint8Array;
  extra: Uint8Array;
  skip: number;
};

type WritablePatchFile = PatchReadablePatchFile<
  Uint8Array,
  {
    littleEndian: boolean;
    readU64(): number;
    writeBytes(bytes: Uint8Array): void;
    writeU8(value: number): void;
  }
>;

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class BDF {
  static readonly MAGIC = BDF_MAGIC;

  patchedSize = 0;
  records: BdfRecord[] = [];

  apply(file: WritablePatchFile, _validate: boolean, applyOptions?: PatchApplyOptions<WritablePatchFile>) {
    const createOutputFile = resolveCreateOutputFile(PatchPatchFile, applyOptions) as (
      size: number,
    ) => WritablePatchFile;
    var tempFile = createOutputFile(this.patchedSize);

    for (const record of this.records) {
      for (const b of record.diff) {
        tempFile.writeU8(file.readU8() + b);
      }
      tempFile.writeBytes(record.extra);
      file.seek(file.offset + record.skip);
    }
    return tempFile;
  }

  static fromFile(file: WritablePatchFile) {
    var patch = new BDF();

    file.seek(8);
    file.littleEndian = true;
    var controlSize = file.readU64();
    var diffSize = file.readU64();
    patch.patchedSize = file.readU64();

    var controlCompressed = file.readBytes(controlSize);
    var diffCompressed = file.readBytes(diffSize);
    var extraCompressed = file.readBytes(file.fileSize - file.offset);

    var controlFile = new PatchPatchFile(bz2.decompress(controlCompressed));
    controlFile.littleEndian = true;
    var diffFile = new PatchPatchFile(bz2.decompress(diffCompressed));
    var extraFile = new PatchPatchFile(bz2.decompress(extraCompressed));

    while (!controlFile.isEOF()) {
      const diffLen = controlFile.readU64();
      const extraLen = controlFile.readU64();
      let skip = controlFile.readU64();
      if (skip & (1 << 63)) skip = -(skip & ~(1 << 63));
      const diff = diffFile.readBytes(diffLen);
      const extra = extraFile.readBytes(extraLen);
      patch.records.push({ diff, extra, skip });
    }

    return patch;
  }
}

export default BDF;
