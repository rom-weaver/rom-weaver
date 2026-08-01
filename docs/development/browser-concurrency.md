# Browser concurrency protocols

rom-weaver runs its WASM engine in a dedicated worker. That engine can start
more WASI workers for parallel work. Two `SharedArrayBuffer` protocols keep
thread startup and browser file access safe.

Both protocols require a cross-origin-isolated page, `SharedArrayBuffer`, and
`Atomics`. This page describes the contract. The TypeScript constants remain
the source of truth.

<!-- START doctoc -->
## Table of contents

- [WASI thread-start barrier](#wasi-thread-start-barrier)
  - [Nested spawns](#nested-spawns)
- [OPFS proxy channel](#opfs-proxy-channel)
  - [Control words](#control-words)
  - [States](#states)
  - [Request flow](#request-flow)
  - [Safety rules](#safety-rules)
- [Browser file input paths](#browser-file-input-paths)

<!-- END doctoc -->

## WASI thread-start barrier

The wire constants and small `Atomics` helpers live in
`packages/rom-weaver-webapp/src/wasm/browser-wasi-thread-protocol.ts`.
`browser-wasi-thread-pool.ts` manages the worker pool, and
`workers/browser-wasi-thread-worker.ts` runs `wasi_thread_start`.

The barrier serializes thread startup. Each new thread may grow shared WASM
memory while allocating its stack. Starting several threads at once can race
the browser's shared-memory update and cause an out-of-bounds hang. The caller
therefore waits until one thread has started before it starts the next one.

Each worker has a four-word control buffer:

| Index | Value | Direction |
| --- | --- | --- |
| 0 | state | both |
| 1 | WASI thread ID | caller to worker |
| 2 | `wasi_thread_start` argument | caller to worker |
| 3 | error flag | worker to caller |

The state values are:

| Value | State | Meaning |
| --- | --- | --- |
| 0 | `IDLE` | Ready for work, or finished. |
| 1 | `REQUESTED` | The caller published a start request. |
| 2 | `STARTING` | The worker is creating its WASI instance. |
| 3 | `RUNNING` | The worker acknowledged startup. |
| 5 | `FAILED` | Startup failed. |
| 6 | `SHUTDOWN` | The pool is stopping. |

The caller writes the thread ID and argument, stores `REQUESTED`, and wakes the
worker. It then blocks in 100 ms slices until the state changes to `RUNNING`,
`IDLE`, or `FAILED`. Startup acknowledgement times out after 8 seconds. A worker
shell has 5 seconds to report that it is ready. A synchronous spawn waits up to
250 ms for a free pooled worker before returning `EAGAIN` so the guest can
retry; asynchronous pool selection and command teardown retain a 30 second
limit.

### Nested spawns

A spawned WASI thread can spawn threads of its own. Those nested spawns never
draw from the runner's bounded pool: a parent blocks in `Atomics.wait` on its
children, so queueing a child behind a pool slot that a blocked parent holds
deadlocks the run. As a result, `browser-wasi-nested-thread-workers.ts` gives
every worker realm its own unbounded free list of thread workers.

The free list is deadlock-safe by construction:

- `acquire` never blocks and never runs out. It takes a parked worker or creates
  one, so it is not a contended resource and cannot appear in a wait-for cycle.
- One realm - one JavaScript thread - owns the list, so there is no mutual
  exclusion between realms to deadlock over.
- A worker is parked only after its thread reached `IDLE`, so the peak worker
  count equals the realm's peak simultaneous children.

The list is realm-scoped, not spawner-scoped: the many-entries extract fan-out
runs one short-lived parent thread per archive entry, and a per-parent list would
still pay a fresh worker (a full WASM instantiation plus an OPFS mount rebuild)
per entry. The list is keyed by the identity of the command payload - module, memory,
thread-ID counter, runtime, stream routing - and drained when that key changes,
when the realm's command loop exits, and on shutdown, so a parked worker is never
handed a stale run.

Reused workers run the same `pool-command` loop as pooled shells, so a nested
worker is indistinguishable from a fresh one to the guest: each thread gets its
own WASI instance and fds, and acquires/releases its mounts through the existing
per-realm mount cache.

`OPFS_PROXY_GLOBAL_THREAD_WORKERS_CREATED_INDEX` in the proxy channel's global
control region counts every thread worker created across all realms; the runner
reports it as `[perf] thread workers created=N total=N` at the end of each run.
That number scaling with the workload rather than with concurrency is the
regression the gauge exists to catch.

## OPFS proxy channel

One dedicated proxy worker owns all OPFS `FileSystemSyncAccessHandle` objects.
The main WASM runner and every spawned WASI thread send synchronous filesystem
requests to that worker. This design obeys WebKit's one-handle-per-file rule
and lets spawned threads access files that they cannot open directly.

The implementation is split across:

- `browser-opfs-proxy-protocol.ts`: control layout, states, and operation codes
- `browser-opfs-proxy-channel.ts`: shared-buffer allocation and global controls
- `browser-opfs-proxy-client.ts`: synchronous client used by WASM threads
- `browser-opfs-proxy-server.ts`: request loop and handle ownership
- `workers/browser-opfs-proxy-worker.ts`: dedicated worker entry point
- `browser-opfs-proxy-file.ts`: random-access file adapter

Each slot has a ten-word control buffer and a 2 MiB data buffer. Large reads
and writes are split across several requests. The shared global control buffer
contains a doorbell counter, a poison flag, a handle-ID allocator, and
per-handle version counters.

### Control words

| Index | Value | Direction |
| --- | --- | --- |
| 0 | state | both |
| 1 | operation code | client to proxy |
| 2 | handle ID | client to proxy |
| 3 | offset, low 32 bits | client to proxy |
| 4 | offset, high 32 bits | client to proxy |
| 5 | path or payload length | both |
| 6 | auxiliary value, low 32 bits | both |
| 7 | auxiliary value, high 32 bits | both |
| 8 | result | proxy to client |
| 9 | WASI status code | proxy to client |

The proxy supports open, read, positional read, write, truncate, flush, close,
unlink, make-directory, and size operations. Operation code 9 was the removed
rename operation and must not be reused.

### States

| Value | State | Meaning |
| --- | --- | --- |
| 0 | `IDLE` | A client may claim the slot. |
| 1 | `REQUESTED` | The request is ready for the proxy. |
| 2 | `DONE` | The result and status are ready. |
| 3 | `CONSUMER_LOCKED` | A client owns the slot while filling it. |
| 4 | `PROXY_SERVICING` | The proxy owns the slot while running the operation. |

### Request flow

1. A client changes one slot from `IDLE` to `CONSUMER_LOCKED` with a compare
   and swap.
2. It writes the request, changes the state to `REQUESTED`, increments the
   global doorbell, and wakes the proxy.
3. The proxy changes the slot from `REQUESTED` to `PROXY_SERVICING`, performs
   the operation, and writes its result and status.
4. The proxy changes the state to `DONE` and wakes the client.
5. The client reads the response and returns the slot to `IDLE`.

The proxy scans for work before waiting on the doorbell, so a request cannot be
lost between a scan and a wait. It wakes at least every 250 ms even if no
notification arrives.

### Safety rules

- Keep the two private states, `CONSUMER_LOCKED` and `PROXY_SERVICING`, distinct
  from each other and from every shared state.
- A client waits up to 30 seconds for a free slot and 60 seconds for an
  operation. On an operation timeout it poisons the whole channel instead of
  reusing a slot that the proxy may still own.
- A crashed or poisoned proxy sets the global poison flag and wakes all
  clients. Later operations fail with an I/O error instead of hanging.
- `Atomics.store` on the state word is the publication boundary. Write all
  request or result data before changing the state.
- The proxy shares and reference-counts handles opened for the same path. It
  closes the browser handle only after the last reference is released.

## Browser file input paths

User-selected `File` and `Blob` inputs are not copied into OPFS before every
run. Chrome, Firefox, and files smaller than 64 MiB on WebKit use a direct,
per-thread `FileReaderSync` path. WebKit files of 64 MiB or more use the single
proxy worker because WebKit serializes concurrent reads of the same file.

Files already stored in OPFS always use the OPFS proxy. This keeps one browser
handle owner while allowing every WASI thread to read and write by guest path.
