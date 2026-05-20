const BPS_ACTION_SOURCE_READ = 0;
const BPS_ACTION_TARGET_READ = 1;
const BPS_ACTION_SOURCE_COPY = 2;
const BPS_ACTION_TARGET_COPY = 3;
const BPS_GRANULARITY = 1;

type BpsBuilderPatchFile = {
  fileSize: number;
  readU8At(offset: number): number;
};

type BpsSourceReadAction = {
  type: typeof BPS_ACTION_SOURCE_READ;
  length: number;
};

type BpsTargetReadAction = {
  type: typeof BPS_ACTION_TARGET_READ;
  length: number;
  bytes?: number[] | Uint8Array | null;
};

type BpsSourceCopyAction = {
  type: typeof BPS_ACTION_SOURCE_COPY;
  length: number;
  relativeOffset: number;
};

type BpsTargetCopyAction = {
  type: typeof BPS_ACTION_TARGET_COPY;
  length: number;
  relativeOffset: number;
};

export type BpsBuilderAction = BpsSourceReadAction | BpsTargetReadAction | BpsSourceCopyAction | BpsTargetCopyAction;

type BpsNode = {
  offset: number;
  next: BpsNode | null;
};

const createBpsNode = (offset: number, next: BpsNode | null): BpsNode => ({
  next,
  offset,
});

const createBpsBuilderContext = (original: BpsBuilderPatchFile, modified: BpsBuilderPatchFile) => ({
  patchActions: [] as BpsBuilderAction[],
  sourceByteAt: (offset: number) => original.readU8At(offset),
  sourceSize: original.fileSize,
  targetByteAt: (offset: number) => modified.readU8At(offset),
  targetSize: modified.fileSize,
});

const createTargetReadBuffer = (
  patchActions: BpsBuilderAction[],
  targetByteAt: (offset: number) => number,
  getOutputOffset: () => number,
) => {
  let length = 0;
  return {
    add: (readLength: number) => {
      length += readLength;
    },
    flush: () => {
      if (!length) return;
      const bytes: number[] = [];
      const action: BpsTargetReadAction = {
        bytes,
        length,
        type: BPS_ACTION_TARGET_READ,
      };
      patchActions.push(action);
      let offset = getOutputOffset() - length;
      while (length) {
        bytes.push(targetByteAt(offset++));
        length--;
      }
    },
  };
};

export function createBPSFromFilesLinear(
  original: BpsBuilderPatchFile,
  modified: BpsBuilderPatchFile,
): BpsBuilderAction[] {
  const { patchActions, sourceByteAt, sourceSize, targetByteAt, targetSize } = createBpsBuilderContext(
    original,
    modified,
  );

  let targetRelativeOffset = 0;
  let outputOffset = 0;
  const targetReadBuffer = createTargetReadBuffer(patchActions, targetByteAt, () => outputOffset);

  while (outputOffset < targetSize) {
    let sourceLength = 0;
    for (let n = 0; outputOffset + n < Math.min(sourceSize, targetSize); n++) {
      if (sourceByteAt(outputOffset + n) !== targetByteAt(outputOffset + n)) break;
      sourceLength++;
    }

    let rleLength = 0;
    for (let n = 1; outputOffset + n < targetSize; n++) {
      if (targetByteAt(outputOffset) !== targetByteAt(outputOffset + n)) break;
      rleLength++;
    }

    if (rleLength >= 4) {
      targetReadBuffer.add(1);
      outputOffset++;
      targetReadBuffer.flush();

      const relativeOffset = outputOffset - 1 - targetRelativeOffset;
      patchActions.push({
        length: rleLength,
        relativeOffset,
        type: BPS_ACTION_TARGET_COPY,
      });
      outputOffset += rleLength;
      targetRelativeOffset = outputOffset - 1;
    } else if (sourceLength >= 4) {
      targetReadBuffer.flush();
      patchActions.push({ length: sourceLength, type: BPS_ACTION_SOURCE_READ });
      outputOffset += sourceLength;
    } else {
      targetReadBuffer.add(BPS_GRANULARITY);
      outputOffset += BPS_GRANULARITY;
    }
  }

  targetReadBuffer.flush();
  return patchActions;
}

export function createBPSFromFilesDelta(
  original: BpsBuilderPatchFile,
  modified: BpsBuilderPatchFile,
): BpsBuilderAction[] {
  const { patchActions, sourceByteAt, sourceSize, targetByteAt, targetSize } = createBpsBuilderContext(
    original,
    modified,
  );

  let sourceRelativeOffset = 0;
  let targetRelativeOffset = 0;
  let outputOffset = 0;

  const sourceTree: Array<BpsNode | null> = new Array(65536);
  const targetTree: Array<BpsNode | null> = new Array(65536);
  for (let n = 0; n < 65536; n++) {
    sourceTree[n] = null;
    targetTree[n] = null;
  }

  for (let offset = 0; offset < sourceSize; offset++) {
    let symbol = sourceByteAt(offset);
    if (offset < sourceSize - 1) symbol |= sourceByteAt(offset + 1) << 8;
    sourceTree[symbol] = createBpsNode(offset, sourceTree[symbol] || null);
  }

  const targetReadBuffer = createTargetReadBuffer(patchActions, targetByteAt, () => outputOffset);

  while (outputOffset < modified.fileSize) {
    let maxLength = 0;
    let maxOffset = 0;
    let mode = BPS_ACTION_TARGET_READ;

    let symbol = targetByteAt(outputOffset);
    if (outputOffset < targetSize - 1) symbol |= targetByteAt(outputOffset + 1) << 8;

    {
      let length = 0;
      let offset = outputOffset;
      while (offset < sourceSize && offset < targetSize && sourceByteAt(offset) === targetByteAt(offset)) {
        length++;
        offset++;
      }
      if (length > maxLength) {
        maxLength = length;
        mode = BPS_ACTION_SOURCE_READ;
      }
    }

    {
      let node = sourceTree[symbol];
      while (node) {
        let length = 0;
        let x = node.offset;
        let y = outputOffset;
        while (x < sourceSize && y < targetSize && sourceByteAt(x++) === targetByteAt(y++)) length++;
        if (length > maxLength) {
          maxLength = length;
          maxOffset = node.offset;
          mode = BPS_ACTION_SOURCE_COPY;
        }
        node = node.next;
      }
    }

    {
      let node = targetTree[symbol];
      while (node) {
        let length = 0;
        let x = node.offset;
        let y = outputOffset;
        while (y < targetSize && targetByteAt(x++) === targetByteAt(y++)) length++;
        if (length > maxLength) {
          maxLength = length;
          maxOffset = node.offset;
          mode = BPS_ACTION_TARGET_COPY;
        }
        node = node.next;
      }

      targetTree[symbol] = createBpsNode(outputOffset, targetTree[symbol] || null);
    }

    if (maxLength < 4) {
      maxLength = Math.min(BPS_GRANULARITY, targetSize - outputOffset);
      mode = BPS_ACTION_TARGET_READ;
    }

    if (mode !== BPS_ACTION_TARGET_READ) targetReadBuffer.flush();

    switch (mode) {
      case BPS_ACTION_SOURCE_READ:
        patchActions.push({ length: maxLength, type: BPS_ACTION_SOURCE_READ });
        break;
      case BPS_ACTION_TARGET_READ:
        targetReadBuffer.add(maxLength);
        break;
      case BPS_ACTION_SOURCE_COPY:
      case BPS_ACTION_TARGET_COPY: {
        let relativeOffset: number;
        if (mode === BPS_ACTION_SOURCE_COPY) {
          relativeOffset = maxOffset - sourceRelativeOffset;
          sourceRelativeOffset = maxOffset + maxLength;
        } else {
          relativeOffset = maxOffset - targetRelativeOffset;
          targetRelativeOffset = maxOffset + maxLength;
        }
        patchActions.push({ length: maxLength, relativeOffset, type: mode } as
          | BpsSourceCopyAction
          | BpsTargetCopyAction);
        break;
      }
    }

    outputOffset += maxLength;
  }

  targetReadBuffer.flush();
  return patchActions;
}
