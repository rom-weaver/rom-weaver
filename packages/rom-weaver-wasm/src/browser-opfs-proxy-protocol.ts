// Shared wire protocol for the OPFS proxy worker, the sole owner of sync access
// handles. WASM threads publish requests, block on Atomics.wait, and wake when
// the proxy replies; this satisfies WebKit's one-handle-per-file constraint.
//
// Kept dependency-free so every worker can share one definition of the control
// layout, opcodes, states, and raw WASI errno values. STATE stores plus notify
// form the release/acquire fence for each request and response.

// --- Control-word layout (indices into the Int32Array view of a slot's control buffer) -----------

/** Slot state machine word. Both sides poll/notify on this index. */
export const OPFS_PROXY_CONTROL_STATE_INDEX = 0;
/** Operation code for this request (consumer -> proxy). One of OPFS_PROXY_OP_*. */
export const OPFS_PROXY_CONTROL_OPCODE_INDEX = 1;
/** Proxy-global handle id the op targets (consumer -> proxy). OPFS_PROXY_HANDLE_BY_PATH = "by path". */
export const OPFS_PROXY_CONTROL_HANDLE_INDEX = 2;
/** Operand offset, low 32 bits (consumer -> proxy). Byte offset for read/write/pread. */
export const OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX = 3;
/** Operand offset, high 32 bits (consumer -> proxy). Offsets exceed 2^32 for >4 GiB files. */
export const OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX = 4;
/**
 * Primary length (both directions). Consumer->proxy: requested read length, write payload length, or
 * the byte length of the (first) path serialized into the data buffer. Clamped to the data buffer.
 */
export const OPFS_PROXY_CONTROL_LENGTH_INDEX = 5;
/**
 * Auxiliary operand, low 32 bits (both directions). Consumer->proxy: truncate size low, readdir
 * cookie, or open oflags. Proxy->consumer: returned handle id on open.
 */
export const OPFS_PROXY_CONTROL_AUX_LOW_INDEX = 6;
/** Auxiliary operand, high 32 bits (both directions). truncate size high, open rights, etc. */
export const OPFS_PROXY_CONTROL_AUX_HIGH_INDEX = 7;
/** Result word (proxy -> consumer): bytes read/written, returned handle id, or dirent/entry count. */
export const OPFS_PROXY_CONTROL_RESULT_INDEX = 8;
/** Status word (proxy -> consumer): a raw WASI errno (0 = success). OPFS_PROXY_STATUS_EIO on failure. */
export const OPFS_PROXY_CONTROL_STATUS_INDEX = 9;
/** Number of Int32 words in a slot's control buffer. Both sides allocate/validate against this. */
export const OPFS_PROXY_CONTROL_WORD_COUNT = 10;

// --- Slot state machine (values stored at OPFS_PROXY_CONTROL_STATE_INDEX) -------------------------
//
// IDLE/REQUESTED/DONE are the shared wire states. CONSUMER_LOCKED and PROXY_SERVICING are private
// in-flight markers owned by one side only; they are defined here together so their values can never
// collide with the shared states or with each other. Do not reuse a value for two meanings.

/** Slot is free; its owning consumer thread may claim it. */
export const OPFS_PROXY_STATE_IDLE = 0;
/** Consumer has published a request; the proxy should service it. */
export const OPFS_PROXY_STATE_REQUESTED = 1;
/** Proxy has fulfilled the request; result/status are valid for the consumer to read. */
export const OPFS_PROXY_STATE_DONE = 2;
/** Consumer-private: slot reserved (claimed from IDLE) but the request is not yet published. */
export const OPFS_PROXY_STATE_CONSUMER_LOCKED = 3;
/** Proxy-private: proxy owns the slot mid-service (claimed from REQUESTED). */
export const OPFS_PROXY_STATE_PROXY_SERVICING = 4;

// --- Operation codes (values stored at OPFS_PROXY_CONTROL_OPCODE_INDEX) ---------------------------

/** Open (or create) a file by path; returns a handle id in AUX_LOW. data buffer holds the UTF-8 path. */
export const OPFS_PROXY_OP_OPEN = 1;
/** Read at OFFSET into the data buffer; returns bytes read in RESULT. */
export const OPFS_PROXY_OP_READ = 2;
/** Positional read (same as READ; kept distinct so the proxy can skip cursor bookkeeping). */
export const OPFS_PROXY_OP_PREAD = 3;
/** Write LENGTH bytes from the data buffer at OFFSET; returns bytes written in RESULT. */
export const OPFS_PROXY_OP_WRITE = 4;
/** Truncate the handle to (AUX_HIGH:AUX_LOW) bytes. */
export const OPFS_PROXY_OP_TRUNCATE = 5;
/** Flush the handle to OPFS. */
export const OPFS_PROXY_OP_FLUSH = 6;
/** Release one reference to the handle; the proxy closes the SyncAccessHandle on the last release. */
export const OPFS_PROXY_OP_CLOSE = 7;
/** Unlink a file by path (data buffer holds the UTF-8 path). */
export const OPFS_PROXY_OP_UNLINK = 8;
// 9 retired (was OP_RENAME); not reused so the wire numbering stays stable.
/** Create a directory by path (data buffer holds the UTF-8 path). */
export const OPFS_PROXY_OP_MKDIR = 10;
/** Return the byte size of a handle in RESULT (proxy reads the live SyncAccessHandle size). */
export const OPFS_PROXY_OP_SIZE = 11;

// --- Status values (raw WASI errno carried in OPFS_PROXY_CONTROL_STATUS_INDEX) --------------------
//
// On success STATUS is 0. On a recognised filesystem error the proxy stores the matching WASI errno
// (e.g. ERRNO_NOENT = 44, ERRNO_EXIST = 20) so Rust's std::fs surfaces a real io::Error kind. A proxy
// that is poisoned/crashed, or any unrecognised throw, surfaces as ERRNO_IO so callers fail rather
// than hang. These two are spelled out here to avoid importing wasiShim into this dependency-free module.

/** Operation succeeded. */
export const OPFS_PROXY_STATUS_OK = 0;
/** Generic I/O failure (WASI ERRNO_IO). Used for proxy poison and any unrecognised error. */
export const OPFS_PROXY_STATUS_EIO = 29;

// --- Sentinels & sizing --------------------------------------------------------------------------

/** HANDLE_INDEX sentinel meaning "resolve by the path serialized into the data buffer". */
export const OPFS_PROXY_HANDLE_BY_PATH = 0;

/**
 * Per-slot transfer buffer. 2 MiB is the measured Safari knee: smaller buffers
 * add enough Atomics round trips and scheduling pressure to stall large
 * extracts, while 4 MiB showed no gain and doubles shared-memory cost.
 */
export const OPFS_PROXY_DATA_BUFFER_BYTES = 2 * 1024 * 1024;
