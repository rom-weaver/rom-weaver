import type { PatchFileBytes, WritablePatchPatchFileLike } from "../../shared/binary/types.ts";

type MinimalWritablePatchFileLike<TBytes extends PatchFileBytes = PatchFileBytes> = Pick<
  WritablePatchPatchFileLike<TBytes>,
  "seek" | "writeBytes" | "writeU8"
>;
type PatchPatchFileConstructor<TFile extends MinimalWritablePatchFileLike = MinimalWritablePatchFileLike> = new (
  size: number,
) => TFile;

type PatchApplyOptions<TFile extends MinimalWritablePatchFileLike = MinimalWritablePatchFileLike> = {
  outputFileFactory?: (size: number) => TFile;
};

type CopySourcePatchFileLike<TBytes extends PatchFileBytes = PatchFileBytes> = MinimalWritablePatchFileLike<TBytes> & {
  copyTo(target: MinimalWritablePatchFileLike<TBytes>, offset?: number, length?: number, fileOffset?: number): void;
  fileSize: number;
};

type XorSourcePatchFileLike<TBytes extends PatchFileBytes = PatchFileBytes> = CopySourcePatchFileLike<TBytes> & {
  isEOF(): boolean;
  readU8(): number;
};

type PatchRecord = {
  offset: number;
  type?: RuntimeValue;
  length?: number;
  byte?: number;
  data?: Uint8Array;
};

type XorPatchRecord = {
  offset: number;
  xor: ArrayLike<number>;
};

const resolveCreateOutputFile = <TFile extends MinimalWritablePatchFileLike>(
  PatchFileClass: PatchPatchFileConstructor<TFile>,
  applyOptions?: PatchApplyOptions<TFile> | null,
): ((size: number) => TFile) =>
  applyOptions && typeof applyOptions.outputFileFactory === "function"
    ? applyOptions.outputFileFactory
    : (size) => new PatchFileClass(size);

const assertPatchValidation = (validate: boolean, isValid: boolean, message: string) => {
  if (validate && !isValid) throw new Error(message);
};

const copySourceToOutput = <TFile extends MinimalWritablePatchFileLike>(
  tempFile: TFile,
  sourceFile: CopySourcePatchFileLike,
  copyLength = sourceFile.fileSize,
) => {
  sourceFile.copyTo(tempFile, 0, copyLength);
  return tempFile;
};

const createPatchedOutputFile = <TFile extends MinimalWritablePatchFileLike>(
  PatchFileClass: PatchPatchFileConstructor<TFile>,
  sourceFile: CopySourcePatchFileLike,
  outputSize: number,
  applyOptions?: PatchApplyOptions<TFile> | null,
  copyLength = sourceFile.fileSize,
) => {
  const tempFile = resolveCreateOutputFile(PatchFileClass, applyOptions)(outputSize);
  return copySourceToOutput(tempFile, sourceFile, copyLength);
};

const applyPatchRecords = (
  tempFile: MinimalWritablePatchFileLike,
  records: PatchRecord[],
  rleType: RuntimeValue,
): void => {
  for (const record of records) {
    tempFile.seek(record.offset);
    if (record.type === rleType) {
      const length = typeof record.length === "number" ? record.length : 0;
      const byte = typeof record.byte === "number" ? record.byte : 0;
      for (let j = 0; j < length; j++) tempFile.writeU8(byte);
    } else {
      tempFile.writeBytes(record.data || new Uint8Array(0));
    }
  }
};

const applyXorRecord = (
  tempFile: MinimalWritablePatchFileLike,
  sourceFile: XorSourcePatchFileLike,
  record: XorPatchRecord,
): void => {
  sourceFile.seek(record.offset);
  tempFile.seek(record.offset);
  for (const value of Array.from(record.xor)) {
    tempFile.writeU8((sourceFile.isEOF() ? 0x00 : sourceFile.readU8()) ^ (value ?? 0));
  }
};

const applyXorRecords = (
  tempFile: MinimalWritablePatchFileLike,
  sourceFile: XorSourcePatchFileLike,
  records: XorPatchRecord[],
): void => {
  for (const record of records) applyXorRecord(tempFile, sourceFile, record);
};

export type {
  CopySourcePatchFileLike,
  MinimalWritablePatchFileLike,
  PatchApplyOptions,
  PatchPatchFileConstructor,
  XorSourcePatchFileLike,
};
export {
  applyPatchRecords,
  applyXorRecord,
  applyXorRecords,
  assertPatchValidation,
  copySourceToOutput,
  createPatchedOutputFile,
  resolveCreateOutputFile,
};
