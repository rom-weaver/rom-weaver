# Browser Concurrency Protocols

rom-weaver runs the WASM engine on a dedicated worker thread (and that engine spawns
its own pool of WASI threads for rayon-parallel work). Two hand-rolled
`SharedArrayBuffer` + `Atomics` protocols hold this together. They are subtle, they
have each been the source of hard-to-reproduce hangs, and their two halves usually
live in different files (sometimes different packages). This document is the prose
spec; the machine-readable constants live in
`packages/rom-weaver-webapp/src/wasm/browser-virtual-file-protocol.ts`.

Everything here requires a cross-origin-isolated context (`crossOriginIsolated`),
`SharedArrayBuffer`, and `Atomics`. The producer half of the virtual-file channel
also requires `Atomics.waitAsync` (the page main thread may not block).

---

## 1. WASI thread-start handshake (the "start barrier")

**Where:** the wire constants and Atomics leaf helpers (`allocateThreadId`,
`signalThreadStartState`, `waitForThreadStartAck`, …) live in
`packages/rom-weaver-webapp/src/wasm/browser-wasi-thread-protocol.ts`. The requester glue
(`spawn`, the worker pool) is in
`packages/rom-weaver-webapp/src/wasm/rom-weaver-browser-opfs-api.ts`, and the worker that
actually runs `wasi_thread_start` is
`packages/rom-weaver-webapp/src/wasm/workers/browser-wasi-thread-worker.ts`.

**Why it exists.** The threaded wasm module imports `wasi.thread-spawn`. When several
threads start at once, each one allocates its stack, which triggers `memory.grow` on
the shared `WebAssembly.Memory`. Concurrent `memory.grow` races V8's propagation of
the new shared-buffer size to already-running threads, producing out-of-bounds
access and a silent hang (8-thread browser decode). The fix is to make spawning
**serialized and synchronous**: the requester publishes one spawn request and then
*blocks until the new thread acknowledges it has started* before returning from
`thread-spawn`. That blocking ack is the start barrier. See the memory notes
"CHD browser decode grow-race root cause" and "Browser thread-count cap".

**Control word** - `Int32Array` over each pooled worker's `startControlBuffer`:

| Index | Constant                      | Meaning                                  |
|-------|-------------------------------|------------------------------------------|
| 0     | `THREAD_SLOT_STATE_INDEX`     | state machine word (below)               |
| 1     | `THREAD_SLOT_TID_INDEX`       | wasi thread id (requester → worker)      |
| 2     | `THREAD_SLOT_START_ARG_INDEX` | `wasi_thread_start` arg (requester → worker) |
| 3     | `THREAD_SLOT_ERROR_INDEX`     | error flag (worker → requester)          |

`THREAD_SLOT_LENGTH = 4` words per slot.

**States** (value 4 is intentionally unused):

| Value | State                        | Set by    |
|-------|------------------------------|-----------|
| 0     | `THREAD_SLOT_STATE_IDLE`     | worker (on completion) / initial |
| 1     | `THREAD_SLOT_STATE_REQUESTED`| requester |
| 2     | `THREAD_SLOT_STATE_STARTING` | worker    |
| 3     | `THREAD_SLOT_STATE_RUNNING`  | worker    |
| 5     | `THREAD_SLOT_STATE_FAILED`   | worker    |
| 6     | `THREAD_SLOT_STATE_SHUTDOWN` | pool teardown |

**Transitions.**

1. Requester (`spawn`, inside the wasm thread-spawn import): claims an idle pooled
   worker, writes TID + START_ARG, clears ERROR, stores `REQUESTED`, `notify`s.
2. Requester then calls `waitForThreadStartAck` and **blocks** (`Atomics.wait` in
   100 ms slices) until the slot leaves `REQUESTED`/`STARTING`. This is the barrier:
   the next spawn cannot begin until this thread is up.
3. Worker picks up `REQUESTED`, stores `STARTING`, builds its WASI fds + instance,
   stores `RUNNING` immediately before calling `wasi_thread_start`, which unblocks
   the requester (`RUNNING` or `IDLE` → success).
4. If the worker throws before acking, it stores `FAILED`; `waitForThreadStartAck`
   returns the error and the requester reports `EAGAIN` to wasm.
5. When the thread function returns, the worker stores `IDLE`; `waitForWorkers`
   reaps `IDLE` (done) and `FAILED` (record + propagate first failure).

**Timeouts:** `THREAD_START_ACK_TIMEOUT_MS = 8000`,
`THREAD_WORKER_READY_TIMEOUT_MS = 5000` (worker shell `shell-ready` message),
busy-retry `25 ms` interval / `30 s` ceiling when no pooled worker is free.

---

## 2. Virtual-file SharedArrayBuffer read channel

**Where:**
- Producer (page main thread, owns the `File`/`Blob`):
  `packages/rom-weaver-webapp/src/workers/protocol/browser-virtual-files.ts`
- Consumer (wasm worker thread, `BrowserVirtualRandomAccessFile`):
  `packages/rom-weaver-webapp/src/wasm/browser-opfs-io-adapters.ts`
- Shared constants (the wire contract): **`browser-virtual-file-protocol.ts`** - both
  files above import from it so they can never disagree on the layout or state values.

**Why it exists.** A virtual file lets the wasm engine read a user-picked file's bytes
*on demand* without first copying the whole file into OPFS. The bytes are owned by the
main thread; the wasm consumer requests ranges over shared memory. Spawned worker
threads that need OPFS-backed files instead go through the dedicated OPFS proxy worker,
which owns the sole `SyncAccessHandle` per file and services every thread's reads (the
old read-on-main gates are retired). Small `Blob`s skip the channel and are read
directly; larger inputs use the proxy.

**Slot** = one `controlBuffer` (`Int32Array` of `VIRTUAL_FILE_CONTROL_WORD_COUNT = 6`
words) + one `dataBuffer` (`Uint8Array`, up to `maxChunkSize`). A proxy has 1–4 slots
so the consumer can have a few reads in flight; total SAB per file is capped
(`VIRTUAL_FILE_MAX_TOTAL_SAB_BYTES_PER_FILE`).

**Control word:**

| Index | Constant                                | Direction            |
|-------|-----------------------------------------|----------------------|
| 0     | `VIRTUAL_FILE_CONTROL_STATE_INDEX`      | both (state machine) |
| 1     | `VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX` | consumer → producer  |
| 2     | `VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX`| consumer → producer  |
| 3     | `VIRTUAL_FILE_CONTROL_LENGTH_INDEX`     | consumer → producer  |
| 4     | `VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX` | producer → consumer  |
| 5     | `VIRTUAL_FILE_CONTROL_STATUS_INDEX`     | producer → consumer  |

The 64-bit read offset is split low/high so it survives files larger than 4 GiB.
Status is `VIRTUAL_FILE_STATUS_OK` (0) / `VIRTUAL_FILE_STATUS_ERROR` (1).

**States:**

| Value | State                              | Owner / meaning                             |
|-------|------------------------------------|---------------------------------------------|
| 0     | `VIRTUAL_FILE_STATE_IDLE`          | free; consumer may claim                     |
| 1     | `VIRTUAL_FILE_STATE_REQUESTED`     | consumer published a request                 |
| 2     | `VIRTUAL_FILE_STATE_DONE`          | producer fulfilled; bytesRead/status valid   |
| 3     | `VIRTUAL_FILE_STATE_CONSUMER_LOCKED` | consumer-private: claimed, not yet published |
| 4     | `VIRTUAL_FILE_STATE_PRODUCER_READING`| producer-private: owns slot mid-read       |

**Transitions.**

1. Consumer `acquireProxySlot`: `CAS IDLE → CONSUMER_LOCKED` to claim a slot
   (reclaiming any stale `DONE` slot first).
2. Consumer writes offset/length, then `store REQUESTED` + `notify`.
3. Producer pump waits (via `Atomics.waitAsync`) for `REQUESTED`, then
   `CAS REQUESTED → PRODUCER_READING` to take ownership, and reads the source async.
4. Producer, **only if the slot is still `PRODUCER_READING`**, copies bytes into the
   data buffer, writes bytesRead + status, `store DONE` + `notify`.
5. Consumer (blocking `Atomics.wait` in 100 ms slices) wakes on `DONE`, copies out,
   and `releaseProxySlot` → `store IDLE` + `notify`.

**Invariants - do not break these:**

- **The two private markers (`CONSUMER_LOCKED = 3`, `PRODUCER_READING = 4`) must never
  share a value** with each other or with a shared state. They are defined together in
  `browser-virtual-file-protocol.ts` precisely so this is enforced in one place rather
  than by matching comments in two packages.
- **Timeout poisoning.** If a consumer read exceeds `VIRTUAL_FILE_PROXY_READ_TIMEOUT_MS`,
  the producer may still own the slot mid-read. The consumer therefore *abandons* that
  slot (never recycles it) and sets `proxyFailed`, failing fast on subsequent reads, so a
  late producer completion can never satisfy a newer request on a reused slot.
- **Producer ownership check (the mirror).** Before publishing, the producer re-checks the
  slot is still `PRODUCER_READING`. If the consumer abandoned the request, the slot is no
  longer `PRODUCER_READING`, so the producer discards its bytes instead of writing stale
  data into a buffer a later request might read.

**Timeouts / geometry:** `VIRTUAL_FILE_PROXY_READ_TIMEOUT_MS = 12000`,
`VIRTUAL_FILE_PROXY_SLOT_ACQUIRE_TIMEOUT_MS = 8000`, atomics wait slice `100 ms`,
chunk size clamped to `[256 KiB, 2 MiB]`.

---

## Known duplication (follow-ups, not yet shared)

These are intentionally left as-is for now; flagged so a future cleanup is deliberate:

- There are **two separate** `waitForAtomicsStateChange` implementations - one in
  `browser-wasi-thread-protocol.ts` (thread start barrier) and one in
  `browser-opfs-io-adapters.ts` (virtual-file channel). They are **not** identical: the
  thread one uses `Date.now()` and falls back to a single bounded `Atomics.wait`; the
  io-adapters one uses `performance.now()` and always loops in slices, with different
  return values. Unifying them means reconciling those semantics, so it is a separate
  change with its own perf check - not a mechanical de-dup.
- Read-cache geometry constants (block bytes/count) differ between the OPFS sync-handle
  path and the virtual-blob path by design (different access patterns); see the comments
  in `browser-opfs-io-adapters.ts`.
