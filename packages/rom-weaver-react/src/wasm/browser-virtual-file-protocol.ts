// Shared wire-protocol definition for the browser "virtual file" SharedArrayBuffer read channel.
//
// A virtual file lets the WASM runtime (running on a dedicated worker thread) read bytes that are
// owned by the page's main thread (a File/Blob the user picked, or a typed array) WITHOUT first
// copying the whole file into OPFS. It is a single-producer / single-consumer-per-slot channel:
//
//   producer  = the React main thread, in workers/protocol/browser-virtual-files.ts. Owns the
//               File/Blob, fills data buffers in response to requests.
//   consumer  = the WASM worker thread, in browser-opfs-io-adapters.ts (BrowserVirtualRandomAccessFile).
//               Issues read requests and blocks on Atomics.wait until the producer answers.
//
// Each proxy has N independent slots. A slot is two SharedArrayBuffers:
//   controlBuffer -> an Int32Array of CONTROL_WORD_COUNT words (the indices below)
//   dataBuffer    -> a Uint8Array the producer copies the requested bytes into
//
// Both halves live in different packages and never share a value at runtime; they only agree by
// importing the constants below. That is the whole point of this module: it is the ONE place the
// control-word layout and the state values are defined, so the producer and consumer can never
// silently disagree on the wire format. See docs/browser-concurrency.md for the protocol prose,
// the state-transition table, and the historical bugs (slot poisoning on timeout, etc.).

// --- Control-word layout (indices into the Int32Array view of controlBuffer) ---------------------

/** Slot state machine word. Both sides poll/notify on this index. */
export const VIRTUAL_FILE_CONTROL_STATE_INDEX = 0;
/** Requested read offset, low 32 bits (consumer -> producer). */
export const VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX = 1;
/** Requested read offset, high 32 bits (consumer -> producer). Offsets exceed 2^32 for >4 GiB files. */
export const VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX = 2;
/** Requested read length in bytes (consumer -> producer), clamped to the data buffer. */
export const VIRTUAL_FILE_CONTROL_LENGTH_INDEX = 3;
/** Bytes actually written into the data buffer (producer -> consumer). */
export const VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX = 4;
/** Read status (producer -> consumer): VIRTUAL_FILE_STATUS_OK / VIRTUAL_FILE_STATUS_ERROR. */
export const VIRTUAL_FILE_CONTROL_STATUS_INDEX = 5;
/** Number of Int32 words in a control buffer. Both sides allocate/validate against this. */
export const VIRTUAL_FILE_CONTROL_WORD_COUNT = 6;

// --- Slot state machine (values stored at VIRTUAL_FILE_CONTROL_STATE_INDEX) ----------------------
//
// IDLE/REQUESTED/DONE are the shared wire states. LOCKED and READING are private in-flight markers
// owned by one side only; they are defined here together so their values can never collide with the
// shared states or with each other. Do not reuse a value for two meanings.

/** Slot is free; the consumer may claim it. */
export const VIRTUAL_FILE_STATE_IDLE = 0;
/** Consumer has published a read request; the producer should service it. */
export const VIRTUAL_FILE_STATE_REQUESTED = 1;
/** Producer has fulfilled the request; bytesRead/status are valid for the consumer to read. */
export const VIRTUAL_FILE_STATE_DONE = 2;
/** Consumer-private: slot reserved (claimed from IDLE) but the request is not yet published. */
export const VIRTUAL_FILE_STATE_CONSUMER_LOCKED = 3;
/** Producer-private: producer owns the slot mid-read (claimed from REQUESTED). */
export const VIRTUAL_FILE_STATE_PRODUCER_READING = 4;

// --- Read status (values stored at VIRTUAL_FILE_CONTROL_STATUS_INDEX) ----------------------------

export const VIRTUAL_FILE_STATUS_OK = 0;
export const VIRTUAL_FILE_STATUS_ERROR = 1;
