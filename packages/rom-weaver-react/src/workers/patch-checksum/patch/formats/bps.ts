/* BPS module for RomWeaver v20240821 - Marc Robledo 2016-2024 - http://www.romhacking.net/license */
/* File format specification: https://www.romhacking.net/documents/746/ */

import type { TypedPatchFileConstructor } from "../../../shared/binary/types.ts";
import PatchFile from "../../../shared/file-io/patch-file.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import type { BpsAction, BpsPatchLike, WritablePatchFile, WritablePatchFileWithVlv } from "./bps-runtime.ts";
import {
  applyBpsPatch,
  BPS_MAGIC,
  buildBpsFromRomsAsync,
  exportBpsPatch,
  readBpsFromFile,
  readBpsFromFileAsync,
  readSummary,
} from "./bps-runtime.ts";

const PatchPatchFile = PatchFile as RuntimeValue as TypedPatchFileConstructor<WritablePatchFile>;

class BPS implements BpsPatchLike {
  static readonly MAGIC = BPS_MAGIC;
  static readonly readSummary = readSummary;

  actions: BpsAction[] | null = [];
  metaData = "";
  patchChecksum = 0;
  sourceChecksum = 0;
  sourceSize = 0;
  targetChecksum = 0;
  targetSize = 0;
  _streamActionFile?: WritablePatchFileWithVlv;
  _streamActionsOffset?: number;
  _streamEndOffset?: number;

  static fromFile(file: WritablePatchFileWithVlv, options?: Parameters<typeof readBpsFromFile>[2]) {
    return readBpsFromFile(() => new BPS(), file, options);
  }

  static fromFileAsync(file: WritablePatchFileWithVlv, options?: Parameters<typeof readBpsFromFileAsync>[2]) {
    return readBpsFromFileAsync(() => new BPS(), file, options);
  }

  static buildFromRomsAsync(original: WritablePatchFile, modified: WritablePatchFile, deltaMode?: boolean) {
    return buildBpsFromRomsAsync(() => new BPS(), original, modified, deltaMode);
  }

  calculateFileChecksumAsync() {
    const patchFile = this.export();
    return computeCRC32(patchFile, 0, patchFile.fileSize - 4);
  }

  async validateSourceAsync(romFile: WritablePatchFile, headerSize?: number) {
    return this.sourceChecksum === (await computeCRC32(romFile, headerSize));
  }

  getValidationInfo() {
    return {
      targetValue: this.targetChecksum,
      type: "CRC32" as const,
      value: this.sourceChecksum,
    };
  }

  export(fileName?: string) {
    return exportBpsPatch(PatchPatchFile, this, fileName);
  }

  toString() {
    let s = `Source size: ${this.sourceSize}`;
    s += `\nTarget size: ${this.targetSize}`;
    s += `\nMetadata: ${this.metaData}`;
    s += `\n#Actions: ${Array.isArray(this.actions) ? this.actions.length : "streamed"}`;
    return s;
  }

  apply(
    romFile: WritablePatchFile,
    validate: boolean,
    applyOptions?: PatchApplyOptions<WritablePatchFile> & {
      onProgress?: (progress: { label: string; percent: number | null }) => void;
      onTrace?: (message: string, details?: Record<string, unknown>) => void;
    },
  ) {
    return applyBpsPatch(PatchPatchFile, this, romFile, validate, applyOptions);
  }
}

export default BPS;
