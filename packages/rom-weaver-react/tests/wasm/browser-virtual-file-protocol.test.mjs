import { describe, expect, it } from "vitest";
import {
  VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX,
  VIRTUAL_FILE_CONTROL_LENGTH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX,
  VIRTUAL_FILE_CONTROL_STATE_INDEX,
  VIRTUAL_FILE_CONTROL_STATUS_INDEX,
  VIRTUAL_FILE_CONTROL_WORD_COUNT,
  VIRTUAL_FILE_STATE_CONSUMER_LOCKED,
  VIRTUAL_FILE_STATE_DONE,
  VIRTUAL_FILE_STATE_IDLE,
  VIRTUAL_FILE_STATE_PRODUCER_READING,
  VIRTUAL_FILE_STATE_REQUESTED,
  VIRTUAL_FILE_STATUS_ERROR,
  VIRTUAL_FILE_STATUS_OK,
} from "../../src/wasm/browser-virtual-file-protocol.ts";

// This module is the single wire contract shared by the producer (React main thread,
// browser-virtual-files.ts) and the consumer (wasm worker, browser-opfs-io-adapters.ts).
// These assertions pin the invariants documented in docs/browser-concurrency.md so a
// well-meaning rename/renumber on either side fails here instead of corrupting a read.
describe("virtual-file SharedArrayBuffer protocol contract", () => {
  it("lays out the control words as a packed 0..N-1 index block", () => {
    const indices = [
      VIRTUAL_FILE_CONTROL_STATE_INDEX,
      VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX,
      VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX,
      VIRTUAL_FILE_CONTROL_LENGTH_INDEX,
      VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX,
      VIRTUAL_FILE_CONTROL_STATUS_INDEX,
    ];
    // Every word index is unique and contiguous, and WORD_COUNT covers exactly them.
    expect(new Set(indices).size).toBe(indices.length);
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(VIRTUAL_FILE_CONTROL_WORD_COUNT).toBe(indices.length);
    // State lives at word 0 so both sides poll/notify the same index.
    expect(VIRTUAL_FILE_CONTROL_STATE_INDEX).toBe(0);
  });

  it("keeps every slot state distinct, including the two private in-flight markers", () => {
    const states = [
      VIRTUAL_FILE_STATE_IDLE,
      VIRTUAL_FILE_STATE_REQUESTED,
      VIRTUAL_FILE_STATE_DONE,
      VIRTUAL_FILE_STATE_CONSUMER_LOCKED,
      VIRTUAL_FILE_STATE_PRODUCER_READING,
    ];
    expect(new Set(states).size).toBe(states.length);
    // The whole reason the constants are centralised: the consumer-private LOCKED marker
    // and the producer-private READING marker must never alias each other or a shared state.
    expect(VIRTUAL_FILE_STATE_CONSUMER_LOCKED).not.toBe(VIRTUAL_FILE_STATE_PRODUCER_READING);
  });

  it("uses distinct OK/ERROR status values", () => {
    expect(VIRTUAL_FILE_STATUS_OK).not.toBe(VIRTUAL_FILE_STATUS_ERROR);
  });
});
