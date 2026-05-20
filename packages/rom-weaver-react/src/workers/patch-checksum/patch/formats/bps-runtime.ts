import type {
  PatchWritablePatchFileWithVlv,
  PatchWritableRandomAccessPatchFile,
  TypedPatchFileConstructor,
} from "../../../shared/binary/types.ts";
import { computeCRC32 } from "../../shared/checksum.ts";
import type { PatchApplyOptions } from "../patch-format-utils.ts";
import { resolveCreateOutputFile } from "../patch-format-utils.ts";
import type { BpsBuilderAction } from "./bps-builder.ts";
import { createBPSFromFilesDelta, createBPSFromFilesLinear } from "./bps-builder.ts";

const BPS_MAGIC = "BPS1";
const BPS_ACTION_SOURCE_READ = 0;
const BPS_ACTION_TARGET_READ = 1;
const BPS_ACTION_SOURCE_COPY = 2;
const BPS_ACTION_TARGET_COPY = 3;
const BPS_COPY_CHUNK_SIZE = 1024 * 1024;
const BPS_WRITE_BUFFER_SIZE = 1024 * 1024;
const BPS_RECENT_TARGET_CACHE_SIZE = 4 * 1024 * 1024;

type ProgressEvent = {
  label: string;
  percent: number | null;
};

type WritablePatchFile = PatchWritableRandomAccessPatchFile<
  number[] | Uint8Array,
  {
    fileName?: string;
    _lastRead?: number;
    littleEndian: boolean;
    readU8At(offset: number): number;
    readU32(): number;
    writeU32(value: number): void;
  }
>;

type WritablePatchFileWithVlv = PatchWritablePatchFileWithVlv<WritablePatchFile>;

type BpsTargetReadAction = {
  type: typeof BPS_ACTION_TARGET_READ;
  length: number;
  bytes?: number[] | Uint8Array | null;
  file?: WritablePatchFileWithVlv | null;
  bytesOffset?: number;
};

type BpsAction = Exclude<BpsBuilderAction, { type: typeof BPS_ACTION_TARGET_READ }> | BpsTargetReadAction;

type BpsSummary = {
  validationInfo: {
    type: "CRC32";
    value: number;
    targetValue: number;
  };
  description: string | null;
  sourceSize: number;
  targetSize: number;
  targetChecksum: number;
  patchChecksum: number;
};

type BpsFromFileOptions = {
  lazyTargetRead?: boolean;
  streamActions?: boolean;
};

type BpsTraceCallback = (message: string, details?: Record<string, unknown>) => void;

type BpsPatchLike = {
  sourceSize: number;
  targetSize: number;
  metaData: string;
  actions: BpsAction[] | null;
  sourceChecksum: number;
  targetChecksum: number;
  patchChecksum: number;
  _streamActionFile?: WritablePatchFileWithVlv;
  _streamActionsOffset?: number;
  _streamEndOffset?: number;
  validateSourceAsync(romFile: WritablePatchFile, headerSize?: number): Promise<boolean>;
  getValidationInfo(): {
    type: "CRC32";
    value: number;
    targetValue: number;
  };
  calculateFileChecksumAsync(): Promise<number>;
  apply(
    romFile: WritablePatchFile,
    validate: boolean,
    applyOptions?: PatchApplyOptions<WritablePatchFile> & {
      onProgress?: (progress: ProgressEvent) => void;
      onTrace?: BpsTraceCallback;
    },
  ): Promise<WritablePatchFile>;
  export(fileName?: string): WritablePatchFileWithVlv;
};

type BpsPatchFactory<TPatch extends BpsPatchLike = BpsPatchLike> = () => TPatch;

const toUint8Array = (bytes: number[] | Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return Uint8Array.from(bytes);
};

const readBytesAtCurrentOffset = (file: WritablePatchFile, length: number): Uint8Array => {
  if (typeof file.readBytesAt === "function") {
    const bytes = toUint8Array(file.readBytesAt(file.offset, length));
    file.skip(length);
    return bytes;
  }
  return toUint8Array(file.readBytes(length));
};

const BPS_readVLV = function (this: WritablePatchFile) {
  let data = 0;
  let shift = 1;
  while (true) {
    if (this.offset >= this.fileSize) throw new Error("Invalid BPS patch");
    const x = this.readU8();
    data += (x & 0x7f) * shift;
    if (x & 0x80) break;
    shift <<= 7;
    data += shift;
  }

  this._lastRead = data;
  return data;
};

const BPS_writeVLV = function (this: WritablePatchFile, data: number) {
  while (true) {
    const x = data & 0x7f;
    data >>= 7;
    if (data === 0) {
      this.writeU8(0x80 | x);
      break;
    }
    this.writeU8(x);
    data--;
  }
};

const BPS_getVLVLen = (data: number) => {
  let len = 0;
  while (true) {
    data >>= 7;
    len++;
    if (data === 0) break;
    data--;
  }
  return len;
};

const readSummary = async (file: WritablePatchFileWithVlv): Promise<BpsSummary> => {
  file.readVLV = BPS_readVLV;
  file.littleEndian = true;
  file.seek(0);

  if (file.readString(4) !== BPS_MAGIC) throw new Error("Invalid BPS patch");

  const sourceSize = file.readVLV();
  const targetSize = file.readVLV();
  const metaDataLength = file.readVLV();
  const endActionsOffset = file.fileSize - 12;
  if (endActionsOffset < file.offset || file.offset + metaDataLength > endActionsOffset)
    throw new Error("Invalid BPS patch");

  let metaData = "";
  if (metaDataLength) metaData = file.readString(metaDataLength);

  while (file.offset < endActionsOffset) {
    const data = file.readVLV();
    const actionType = data & 3;
    const actionLength = (data >> 2) + 1;

    if (actionType === BPS_ACTION_TARGET_READ) {
      if (file.offset + actionLength > endActionsOffset) throw new Error("Invalid BPS patch");
      file.skip(actionLength);
    } else if (actionType === BPS_ACTION_SOURCE_COPY || actionType === BPS_ACTION_TARGET_COPY) {
      file.readVLV();
    }

    if (file.offset > endActionsOffset) throw new Error("Invalid BPS patch");
  }

  if (file.offset !== endActionsOffset) throw new Error("Invalid BPS patch");

  const sourceChecksum = file.readU32();
  const targetChecksum = file.readU32();
  const patchChecksum = file.readU32();

  if (patchChecksum !== (await computeCRC32(file, 0, file.fileSize - 4))) throw new Error("Patch checksum mismatch");

  return {
    description: metaData || null,
    patchChecksum,
    sourceSize,
    targetChecksum,
    targetSize,
    validationInfo: {
      targetValue: targetChecksum,
      type: "CRC32" as const,
      value: sourceChecksum,
    },
  };
};

const applyBpsPatch = async (
  PatchPatchFile: TypedPatchFileConstructor<WritablePatchFile>,
  patchInstance: BpsPatchLike,
  romFile: WritablePatchFile,
  validate: boolean,
  applyOptions?: PatchApplyOptions<WritablePatchFile> & {
    onProgress?: (progress: ProgressEvent) => void;
    onTrace?: BpsTraceCallback;
  },
) => {
  const patch = patchInstance;
  const sourceRom = romFile;
  const trace = typeof applyOptions?.onTrace === "function" ? applyOptions.onTrace : null;
  const bpsStartedAt = Date.now();
  const actionStats = {
    appliedActions: 0,
    coalescedActions: 0,
    encodedActions: 0,
    sourceCopyBytes: 0,
    sourceReadBytes: 0,
    targetCopyBytes: 0,
    targetReadBytes: 0,
  };
  const traceBps = (message: string, details: Record<string, unknown> = {}) => {
    trace?.(message, {
      ...details,
      sourceSize: patch.sourceSize,
      targetSize: patch.targetSize,
    });
  };
  traceBps("patch.apply.bps.start", {
    actionCount: Array.isArray(patch.actions) ? patch.actions.length : undefined,
    actionMode: patch._streamActionFile ? "streamed" : "materialized",
    validate,
  });

  if (validate && !(await patch.validateSourceAsync(sourceRom))) {
    throw new Error("Source ROM checksum mismatch");
  }

  const createOutputFile = resolveCreateOutputFile(
    PatchPatchFile as unknown as TypedPatchFileConstructor<WritablePatchFile>,
    applyOptions,
  ) as (size: number) => WritablePatchFile;
  const tempFile = createOutputFile(patch.targetSize);
  let bufferedWriteOffset = 0;
  let bufferedWriteLength = 0;
  let bufferedWriteBytes: Uint8Array | null = null;
  let copyBuffer: Uint8Array | null = null;
  let recentTargetCacheBytes: Uint8Array | null = null;
  let recentTargetCacheEnabled = false;
  let recentTargetCacheOffset = 0;
  let recentTargetCacheLength = 0;
  const ensureWriteBuffer = () => {
    if (!bufferedWriteBytes) bufferedWriteBytes = new Uint8Array(BPS_WRITE_BUFFER_SIZE);
  };
  const ensureCopyBuffer = (minLength: number) => {
    if (!copyBuffer || copyBuffer.byteLength < minLength)
      copyBuffer = new Uint8Array(Math.max(BPS_COPY_CHUNK_SIZE, minLength));
    return copyBuffer;
  };
  const ensureRecentTargetCache = () => {
    if (!recentTargetCacheBytes) recentTargetCacheBytes = new Uint8Array(BPS_RECENT_TARGET_CACHE_SIZE);
  };
  const directReadBytesAt = (file: WritablePatchFile, offset: number, len: number): Uint8Array => {
    if (typeof file.readIntoAt === "function") {
      const bytes = new Uint8Array(len);
      const bytesRead = file.readIntoAt(bytes, 0, len, offset);
      return bytesRead === len ? bytes : bytes.subarray(0, bytesRead);
    }
    if (typeof file.readBytesAt === "function") return toUint8Array(file.readBytesAt(offset, len));
    if (
      (file as { _u8array?: Uint8Array })._u8array &&
      typeof (file as { _u8array?: Uint8Array })._u8array?.subarray === "function"
    )
      return (file as { _u8array: Uint8Array })._u8array.subarray(offset, offset + len);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = readByteAt(file, offset + i);
    return bytes;
  };
  const readByteAt = (file: WritablePatchFile, offset: number): number => {
    if (
      file === tempFile &&
      bufferedWriteLength &&
      offset >= bufferedWriteOffset &&
      offset < bufferedWriteOffset + bufferedWriteLength &&
      bufferedWriteBytes
    ) {
      return bufferedWriteBytes[offset - bufferedWriteOffset] ?? 0;
    }
    if (
      file === tempFile &&
      recentTargetCacheLength &&
      offset >= recentTargetCacheOffset &&
      offset < recentTargetCacheOffset + recentTargetCacheLength &&
      recentTargetCacheBytes
    ) {
      return recentTargetCacheBytes[offset - recentTargetCacheOffset] ?? 0;
    }
    if (typeof file.readU8At === "function") return file.readU8At(offset);
    return (file as { _u8array?: Uint8Array })._u8array?.[offset] ?? 0;
  };
  const appendRecentTargetBytes = (offset: number, bytes: Uint8Array | number[]) => {
    if (!recentTargetCacheEnabled) return;
    const u8array = toUint8Array(bytes);
    if (!u8array.byteLength) return;
    ensureRecentTargetCache();
    if (!recentTargetCacheBytes) return;
    if (recentTargetCacheLength && offset !== recentTargetCacheOffset + recentTargetCacheLength) {
      recentTargetCacheOffset = 0;
      recentTargetCacheLength = 0;
    }
    if (u8array.byteLength >= BPS_RECENT_TARGET_CACHE_SIZE) {
      recentTargetCacheBytes.set(u8array.subarray(u8array.byteLength - BPS_RECENT_TARGET_CACHE_SIZE), 0);
      recentTargetCacheOffset = offset + u8array.byteLength - BPS_RECENT_TARGET_CACHE_SIZE;
      recentTargetCacheLength = BPS_RECENT_TARGET_CACHE_SIZE;
      return;
    }
    if (!recentTargetCacheLength) recentTargetCacheOffset = offset;
    if (recentTargetCacheLength + u8array.byteLength > BPS_RECENT_TARGET_CACHE_SIZE) {
      const keepLength = BPS_RECENT_TARGET_CACHE_SIZE - u8array.byteLength;
      recentTargetCacheBytes.copyWithin(0, recentTargetCacheLength - keepLength, recentTargetCacheLength);
      recentTargetCacheOffset += recentTargetCacheLength - keepLength;
      recentTargetCacheLength = keepLength;
    }
    recentTargetCacheBytes.set(u8array, recentTargetCacheLength);
    recentTargetCacheLength += u8array.byteLength;
  };
  const overlayRecentTargetCache = (output: Uint8Array, outputOffset: number, offset: number, len: number) => {
    if (!(recentTargetCacheLength && recentTargetCacheBytes)) return;
    const overlapStart = Math.max(offset, recentTargetCacheOffset);
    const overlapEnd = Math.min(offset + len, recentTargetCacheOffset + recentTargetCacheLength);
    if (overlapEnd <= overlapStart) return;
    output.set(
      recentTargetCacheBytes.subarray(overlapStart - recentTargetCacheOffset, overlapEnd - recentTargetCacheOffset),
      outputOffset + overlapStart - offset,
    );
  };
  const readTempFileInto = (output: Uint8Array, outputOffset: number, offset: number, len: number) => {
    if (!len) return 0;
    const targetOffset = typeof outputOffset === "number" && outputOffset > 0 ? Math.floor(outputOffset) : 0;
    const readEnd = offset + len;
    if (
      bufferedWriteLength &&
      offset >= bufferedWriteOffset &&
      readEnd <= bufferedWriteOffset + bufferedWriteLength &&
      bufferedWriteBytes
    ) {
      output.set(
        bufferedWriteBytes.subarray(offset - bufferedWriteOffset, readEnd - bufferedWriteOffset),
        targetOffset,
      );
      return len;
    }
    if (
      recentTargetCacheLength &&
      offset >= recentTargetCacheOffset &&
      readEnd <= recentTargetCacheOffset + recentTargetCacheLength &&
      recentTargetCacheBytes
    ) {
      output.set(
        recentTargetCacheBytes.subarray(offset - recentTargetCacheOffset, readEnd - recentTargetCacheOffset),
        targetOffset,
      );
      return len;
    }

    let bytesRead: number;
    if (typeof tempFile.readIntoAt === "function") {
      bytesRead = tempFile.readIntoAt(output, targetOffset, len, offset);
    } else {
      const bytes = directReadBytesAt(tempFile, offset, len);
      output.set(bytes.subarray(0, len), targetOffset);
      bytesRead = bytes.byteLength;
    }

    overlayRecentTargetCache(output, targetOffset, offset, len);
    if (
      bufferedWriteLength &&
      offset + len > bufferedWriteOffset &&
      offset < bufferedWriteOffset + bufferedWriteLength &&
      bufferedWriteBytes
    ) {
      const overlapStart = Math.max(offset, bufferedWriteOffset);
      const overlapEnd = Math.min(offset + len, bufferedWriteOffset + bufferedWriteLength);
      output.set(
        bufferedWriteBytes.subarray(overlapStart - bufferedWriteOffset, overlapEnd - bufferedWriteOffset),
        targetOffset + overlapStart - offset,
      );
    }

    return bytesRead;
  };
  const readBytesAt = (file: WritablePatchFile, offset: number, len: number): Uint8Array => {
    if (file === tempFile) {
      const output = new Uint8Array(len);
      const bytesRead = readTempFileInto(output, 0, offset, len);
      return bytesRead === len ? output : output.subarray(0, bytesRead);
    }
    const bytes = directReadBytesAt(file, offset, len);
    if (
      file !== tempFile ||
      ((!bufferedWriteLength ||
        offset + len <= bufferedWriteOffset ||
        offset >= bufferedWriteOffset + bufferedWriteLength) &&
        (!recentTargetCacheLength ||
          offset + len <= recentTargetCacheOffset ||
          offset >= recentTargetCacheOffset + recentTargetCacheLength))
    ) {
      return bytes;
    }

    const output = new Uint8Array(len);
    output.set(bytes.subarray(0, len), 0);
    overlayRecentTargetCache(output, 0, offset, len);
    if (bufferedWriteBytes) {
      const overlapStart = Math.max(offset, bufferedWriteOffset);
      const overlapEnd = Math.min(offset + len, bufferedWriteOffset + bufferedWriteLength);
      output.set(
        bufferedWriteBytes.subarray(overlapStart - bufferedWriteOffset, overlapEnd - bufferedWriteOffset),
        overlapStart - offset,
      );
    }
    return output;
  };
  const directWriteBytesAt = (file: WritablePatchFile, offset: number, bytes: Uint8Array | number[]) => {
    const u8array = toUint8Array(bytes);
    if (typeof file.writeBytesAt === "function") {
      file.writeBytesAt(offset, u8array);
      if (file === tempFile) appendRecentTargetBytes(offset, u8array);
      return;
    }
    if (
      (file as { _u8array?: Uint8Array })._u8array &&
      typeof (file as { _u8array?: Uint8Array })._u8array?.set === "function"
    ) {
      (file as { _u8array: Uint8Array })._u8array.set(u8array, offset);
      if (file === tempFile) appendRecentTargetBytes(offset, u8array);
      return;
    }
    const previousOffset = file.offset;
    file.seek(offset);
    file.writeBytes(u8array);
    file.seek(previousOffset);
    if (file === tempFile) appendRecentTargetBytes(offset, u8array);
  };
  const flushWriteBuffer = () => {
    if (bufferedWriteLength && bufferedWriteBytes) {
      directWriteBytesAt(tempFile, bufferedWriteOffset, bufferedWriteBytes.subarray(0, bufferedWriteLength));
      bufferedWriteLength = 0;
    }
  };
  const writeBytesAt = (file: WritablePatchFile, offset: number, bytes: Uint8Array | number[]) => {
    const u8array = toUint8Array(bytes);
    if (file !== tempFile || !u8array.byteLength) {
      directWriteBytesAt(file, offset, u8array);
      return;
    }

    let written = 0;
    while (written < u8array.byteLength) {
      if (bufferedWriteLength && offset + written !== bufferedWriteOffset + bufferedWriteLength) flushWriteBuffer();

      const remaining = u8array.byteLength - written;
      if (!bufferedWriteLength && remaining >= BPS_WRITE_BUFFER_SIZE) {
        directWriteBytesAt(tempFile, offset + written, u8array.subarray(written, written + remaining));
        written += remaining;
        continue;
      }

      if (!bufferedWriteLength) {
        ensureWriteBuffer();
        bufferedWriteOffset = offset + written;
      }

      if (!bufferedWriteBytes) break;
      const chunkLength = Math.min(BPS_WRITE_BUFFER_SIZE - bufferedWriteLength, remaining);
      bufferedWriteBytes.set(u8array.subarray(written, written + chunkLength), bufferedWriteLength);
      bufferedWriteLength += chunkLength;
      written += chunkLength;
      if (bufferedWriteLength === BPS_WRITE_BUFFER_SIZE) flushWriteBuffer();
    }
  };
  const writeBytes = (file: WritablePatchFile, bytes: Uint8Array | number[]) => {
    const u8array = toUint8Array(bytes);
    writeBytesAt(file, file.offset, u8array);
    file.skip(u8array.byteLength);
  };
  const copyFromSource = (
    sourceFile: WritablePatchFile,
    targetFile: WritablePatchFile,
    sourceOffset: number,
    len: number,
  ) => {
    let copied = 0;
    while (copied < len) {
      const chunkLength = Math.min(BPS_COPY_CHUNK_SIZE, len - copied);
      const chunkBuffer = ensureCopyBuffer(chunkLength);
      const bytesRead =
        typeof sourceFile.readIntoAt === "function"
          ? sourceFile.readIntoAt(chunkBuffer, 0, chunkLength, sourceOffset + copied)
          : chunkLength;
      writeBytes(
        targetFile,
        bytesRead === chunkLength
          ? chunkBuffer.subarray(0, chunkLength)
          : readBytesAt(sourceFile, sourceOffset + copied, chunkLength),
      );
      copied += chunkLength;
    }
  };
  const copyFromTarget = (targetFile: WritablePatchFile, sourceOffset: number, len: number) => {
    recentTargetCacheEnabled = true;
    let copied = 0;
    while (copied < len) {
      const distance = targetFile.offset - sourceOffset;
      if (distance <= 0) {
        writeBytes(targetFile, [readByteAt(targetFile, sourceOffset)]);
        sourceOffset++;
        copied++;
        continue;
      }

      const chunkLength = Math.min(BPS_COPY_CHUNK_SIZE, len - copied);
      const chunk = ensureCopyBuffer(chunkLength).subarray(0, chunkLength);
      const seedLength = Math.min(distance, chunkLength);
      if (targetFile === tempFile) {
        readTempFileInto(chunk, 0, sourceOffset, seedLength);
      } else if (typeof targetFile.readIntoAt === "function") {
        targetFile.readIntoAt(chunk, 0, seedLength, sourceOffset);
      } else {
        chunk.set(readBytesAt(targetFile, sourceOffset, seedLength), 0);
      }
      let filled = seedLength;
      while (filled < chunkLength) {
        const repeatLength = Math.min(filled, chunkLength - filled);
        chunk.set(chunk.subarray(0, repeatLength), filled);
        filled += repeatLength;
      }
      writeBytes(targetFile, chunk);
      sourceOffset += chunkLength;
      copied += chunkLength;
    }
  };
  const onProgress = applyOptions && typeof applyOptions.onProgress === "function" ? applyOptions.onProgress : null;
  let appliedBytes = 0;
  let nextProgressAt = 0;
  const progressStep = Math.max(BPS_COPY_CHUNK_SIZE, Math.floor((tempFile.fileSize || 0) / 100) || 1);
  const updateProgress = (actionLength: number, force: boolean) => {
    if (!(onProgress && tempFile.fileSize)) return;
    appliedBytes += actionLength;
    if (force || appliedBytes >= nextProgressAt) {
      nextProgressAt = appliedBytes + progressStep;
      onProgress({
        label: "Applying BPS patch...",
        percent: Math.max(0, Math.min(100, (appliedBytes / tempFile.fileSize) * 100)),
      });
    }
  };

  let sourceRelativeOffset = 0;
  let targetRelativeOffset = 0;
  const addActionBytes = (actionType: number, actionLength: number) => {
    if (actionType === BPS_ACTION_SOURCE_READ) actionStats.sourceReadBytes += actionLength;
    else if (actionType === BPS_ACTION_TARGET_READ) actionStats.targetReadBytes += actionLength;
    else if (actionType === BPS_ACTION_SOURCE_COPY) actionStats.sourceCopyBytes += actionLength;
    else if (actionType === BPS_ACTION_TARGET_COPY) actionStats.targetCopyBytes += actionLength;
  };
  const canCoalesceAction = (
    baseType: number,
    nextType: number,
    nextRelativeOffset: number,
    nextActionFile: WritablePatchFileWithVlv | null,
    nextActionBytes: number[] | Uint8Array | null,
    nextActionBytesOffset: number | null,
  ) => {
    if (nextActionFile || nextActionBytes || typeof nextActionBytesOffset === "number") return false;
    if (baseType === BPS_ACTION_SOURCE_READ) return nextType === BPS_ACTION_SOURCE_READ;
    if (baseType === BPS_ACTION_SOURCE_COPY || baseType === BPS_ACTION_TARGET_COPY)
      return nextType === baseType && nextRelativeOffset === 0;
    return false;
  };
  const applyAction = (
    actionType: number,
    actionLength: number,
    relativeOffset: number,
    actionFile: WritablePatchFileWithVlv | null,
    actionBytesOffset: number | null,
    actionBytes: number[] | Uint8Array | null,
  ) => {
    actionStats.appliedActions++;
    addActionBytes(actionType, actionLength);
    if (actionType === BPS_ACTION_SOURCE_READ) {
      copyFromSource(sourceRom as WritablePatchFile, tempFile, tempFile.offset, actionLength);
    } else if (actionType === BPS_ACTION_TARGET_READ) {
      if (typeof actionBytesOffset === "number" && actionFile)
        copyFromSource(actionFile as WritablePatchFile, tempFile, actionBytesOffset, actionLength);
      else writeBytes(tempFile, actionBytes || []);
    } else if (actionType === BPS_ACTION_SOURCE_COPY) {
      sourceRelativeOffset += relativeOffset;
      copyFromSource(sourceRom as WritablePatchFile, tempFile, sourceRelativeOffset, actionLength);
      sourceRelativeOffset += actionLength;
    } else if (actionType === BPS_ACTION_TARGET_COPY) {
      targetRelativeOffset += relativeOffset;
      copyFromTarget(tempFile, targetRelativeOffset, actionLength);
      targetRelativeOffset += actionLength;
    }
    updateProgress(actionLength, false);
  };

  if (patch._streamActionFile) {
    const actionFile = patch._streamActionFile;
    actionFile.readVLV = BPS_readVLV;
    actionFile.littleEndian = true;
    actionFile.seek(patch._streamActionsOffset || 0);
    type StreamAction = {
      actionBytesOffset: number | null;
      actionFile: WritablePatchFileWithVlv | null;
      actionLength: number;
      actionType: number;
      relativeOffset: number;
    };
    let pendingStreamAction: StreamAction | null = null;
    const readNextStreamAction = (): StreamAction | null => {
      if (pendingStreamAction) {
        const action = pendingStreamAction;
        pendingStreamAction = null;
        return action;
      }
      if (actionFile.offset >= (patch._streamEndOffset || 0)) return null;
      actionStats.encodedActions++;
      const data = actionFile.readVLV();
      const actionType = data & 3;
      const actionLength = (data >> 2) + 1;
      if (actionType === BPS_ACTION_TARGET_READ) {
        const bytesOffset = actionFile.offset;
        actionFile.skip(actionLength);
        return { actionBytesOffset: bytesOffset, actionFile, actionLength, actionType, relativeOffset: 0 };
      }
      if (actionType === BPS_ACTION_SOURCE_COPY || actionType === BPS_ACTION_TARGET_COPY) {
        const encodedRelativeOffset = actionFile.readVLV();
        const relativeOffset = (encodedRelativeOffset & 1 ? -1 : 1) * (encodedRelativeOffset >> 1);
        return { actionBytesOffset: null, actionFile: null, actionLength, actionType, relativeOffset };
      }
      return { actionBytesOffset: null, actionFile: null, actionLength, actionType, relativeOffset: 0 };
    };
    for (let action = readNextStreamAction(); action; action = readNextStreamAction()) {
      let actionLength = action.actionLength;
      let coalescedActions = 0;
      for (;;) {
        const nextAction = readNextStreamAction();
        if (!nextAction) break;
        if (
          !canCoalesceAction(
            action.actionType,
            nextAction.actionType,
            nextAction.relativeOffset,
            nextAction.actionFile,
            null,
            nextAction.actionBytesOffset,
          )
        ) {
          pendingStreamAction = nextAction;
          break;
        }
        actionLength += nextAction.actionLength;
        coalescedActions++;
      }
      actionStats.coalescedActions += coalescedActions;
      applyAction(
        action.actionType,
        actionLength,
        action.relativeOffset,
        action.actionFile,
        action.actionBytesOffset,
        null,
      );
    }
  } else {
    for (let i = 0; i < (patch.actions?.length || 0); i++) {
      const action = patch.actions?.[i];
      if (!action) continue;
      actionStats.encodedActions++;
      const actionFile = "file" in action ? action.file || null : null;
      let actionLength = action.length;
      let coalescedActions = 0;
      while (i + 1 < (patch.actions?.length || 0)) {
        const nextAction = patch.actions?.[i + 1];
        if (!nextAction) break;
        if (
          !canCoalesceAction(
            action.type,
            nextAction.type,
            "relativeOffset" in nextAction ? nextAction.relativeOffset : 0,
            "file" in nextAction ? nextAction.file || null : null,
            "bytes" in nextAction ? nextAction.bytes || null : null,
            "bytesOffset" in nextAction ? nextAction.bytesOffset || null : null,
          )
        )
          break;
        actionLength += nextAction.length;
        actionStats.encodedActions++;
        coalescedActions++;
        i++;
      }
      actionStats.coalescedActions += coalescedActions;
      applyAction(
        action.type,
        actionLength,
        "relativeOffset" in action ? action.relativeOffset : 0,
        actionFile,
        "bytesOffset" in action ? action.bytesOffset || null : null,
        "bytes" in action ? action.bytes || null : null,
      );
    }
  }
  flushWriteBuffer();
  updateProgress(0, true);

  if (validate && patch.targetChecksum !== (await computeCRC32(tempFile)))
    throw new Error("Target ROM checksum mismatch");
  traceBps("patch.apply.bps.finish", {
    ...actionStats,
    durationMs: Date.now() - bpsStartedAt,
  });

  return tempFile;
};

const exportBpsPatch = (
  PatchPatchFile: TypedPatchFileConstructor<WritablePatchFile>,
  patch: BpsPatchLike,
  fileName?: string,
) => {
  if (!patch.actions) throw new Error("Cannot export streamed BPS patch without materialized actions");
  let patchFileSize = BPS_MAGIC.length;
  patchFileSize += BPS_getVLVLen(patch.sourceSize);
  patchFileSize += BPS_getVLVLen(patch.targetSize);
  patchFileSize += BPS_getVLVLen(patch.metaData.length);
  patchFileSize += patch.metaData.length;
  for (const action of patch.actions) {
    if (!action) continue;
    patchFileSize += BPS_getVLVLen(((action.length - 1) << 2) + action.type);

    if (action.type === BPS_ACTION_TARGET_READ) {
      patchFileSize += action.length;
    } else if (action.type === BPS_ACTION_SOURCE_COPY || action.type === BPS_ACTION_TARGET_COPY) {
      patchFileSize += BPS_getVLVLen((Math.abs(action.relativeOffset) << 1) + (action.relativeOffset < 0 ? 1 : 0));
    }
  }
  patchFileSize += 12;

  const patchFile = new PatchPatchFile(patchFileSize) as WritablePatchFileWithVlv;
  patchFile.fileName = `${fileName}.bps`;
  patchFile.littleEndian = true;
  patchFile.writeVLV = BPS_writeVLV;

  patchFile.writeString(BPS_MAGIC);
  patchFile.writeVLV(patch.sourceSize);
  patchFile.writeVLV(patch.targetSize);
  patchFile.writeVLV(patch.metaData.length);
  patchFile.writeString(patch.metaData, patch.metaData.length);

  for (const action of patch.actions) {
    if (!action) continue;
    patchFile.writeVLV(((action.length - 1) << 2) + action.type);

    if (action.type === BPS_ACTION_TARGET_READ) {
      patchFile.writeBytes(action.bytes || []);
    } else if (action.type === BPS_ACTION_SOURCE_COPY || action.type === BPS_ACTION_TARGET_COPY) {
      patchFile.writeVLV((Math.abs(action.relativeOffset) << 1) + (action.relativeOffset < 0 ? 1 : 0));
    }
  }
  patchFile.writeU32(patch.sourceChecksum);
  patchFile.writeU32(patch.targetChecksum);
  patchFile.writeU32(patch.patchChecksum);

  return patchFile;
};

const readBpsFromFile = <TPatch extends BpsPatchLike>(
  createPatch: BpsPatchFactory<TPatch>,
  file: WritablePatchFileWithVlv,
  options?: BpsFromFileOptions,
): TPatch => {
  file.readVLV = BPS_readVLV;
  file.littleEndian = true;
  const patch = createPatch();
  const lazyTargetRead = !!options?.lazyTargetRead;
  const streamActions = !!options?.streamActions;

  file.seek(4);

  patch.sourceSize = file.readVLV();
  patch.targetSize = file.readVLV();

  const metaDataLength = file.readVLV();
  if (metaDataLength) patch.metaData = file.readString(metaDataLength);

  const endActionsOffset = file.fileSize - 12;
  if (streamActions) {
    patch.actions = null;
    patch._streamActionFile = file;
    patch._streamActionsOffset = file.offset;
    patch._streamEndOffset = endActionsOffset;
    file.seek(endActionsOffset);
  } else {
    patch.actions = [];
    while (file.offset < endActionsOffset) {
      const data = file.readVLV();
      const actionType = data & 3;
      const actionLength = (data >> 2) + 1;

      if (actionType === BPS_ACTION_TARGET_READ) {
        const action: BpsTargetReadAction = {
          length: actionLength,
          type: BPS_ACTION_TARGET_READ,
        };
        if (lazyTargetRead) {
          action.file = file;
          action.bytesOffset = file.offset;
          file.skip(action.length);
        } else {
          action.bytes = readBytesAtCurrentOffset(file, action.length);
        }
        patch.actions.push(action);
      } else if (actionType === BPS_ACTION_SOURCE_COPY || actionType === BPS_ACTION_TARGET_COPY) {
        const relativeOffset = file.readVLV();
        const decodedRelativeOffset = (relativeOffset & 1 ? -1 : 1) * (relativeOffset >> 1);
        patch.actions.push({
          length: actionLength,
          relativeOffset: decodedRelativeOffset,
          type: actionType,
        } as BpsAction);
      } else {
        patch.actions.push({
          length: actionLength,
          type: BPS_ACTION_SOURCE_READ,
        });
      }
    }
  }

  patch.sourceChecksum = file.readU32();
  patch.targetChecksum = file.readU32();
  patch.patchChecksum = file.readU32();

  return patch;
};

const readBpsFromFileAsync = async <TPatch extends BpsPatchLike>(
  createPatch: BpsPatchFactory<TPatch>,
  file: WritablePatchFileWithVlv,
  options?: BpsFromFileOptions,
): Promise<TPatch> => {
  const patch = readBpsFromFile(createPatch, file, options);
  if (patch.patchChecksum !== (await computeCRC32(file, 0, file.fileSize - 4)))
    throw new Error("Patch checksum mismatch");
  return patch;
};

const buildBpsFromRomsAsync = async <TPatch extends BpsPatchLike>(
  createPatch: BpsPatchFactory<TPatch>,
  original: WritablePatchFile,
  modified: WritablePatchFile,
  deltaMode?: boolean,
): Promise<TPatch> => {
  const patch = createPatch();
  patch.sourceSize = original.fileSize;
  patch.targetSize = modified.fileSize;
  patch.actions = deltaMode
    ? createBPSFromFilesDelta(original, modified)
    : createBPSFromFilesLinear(original, modified);
  patch.sourceChecksum = await computeCRC32(original);
  patch.targetChecksum = await computeCRC32(modified);
  patch.patchChecksum = await patch.calculateFileChecksumAsync();
  return patch;
};

export type { BpsAction, BpsPatchLike, WritablePatchFile, WritablePatchFileWithVlv };
export {
  applyBpsPatch,
  BPS_ACTION_SOURCE_COPY,
  BPS_ACTION_SOURCE_READ,
  BPS_ACTION_TARGET_COPY,
  BPS_ACTION_TARGET_READ,
  BPS_MAGIC,
  buildBpsFromRomsAsync,
  exportBpsPatch,
  readBpsFromFile,
  readBpsFromFileAsync,
  readSummary,
};
