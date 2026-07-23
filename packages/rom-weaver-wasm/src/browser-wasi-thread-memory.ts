import { isErrorLike } from "./browser-wasi-thread-errors.ts";
import { WASI_ERRNO_AGAIN } from "./browser-wasi-thread-protocol.ts";

const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
// 65536 pages * 64 KiB = 4 GiB, matching the module's link-time --max-memory
// (.cargo/config.toml). Engines reserve the maximum's address range up front, so
// constrained hosts (notably iOS) may refuse it - the ladder steps down until one fits.
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 65536;
const FALLBACK_SHARED_MEMORY_MAX_PAGES = [49152, 32768, 24576, 16384, 8192, 4096];

function storeThreadSpawnResult(
  wasmMemory: WebAssembly.Memory,
  errorOrTidPtr: number,
  isError: boolean,
  value: number,
): boolean {
  if (!(wasmMemory instanceof WebAssembly.Memory)) return false;
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) return false;
  const pointer = Number(errorOrTidPtr);
  if (!Number.isInteger(pointer) || pointer < 0) return false;
  try {
    const result = new Int32Array(wasmMemory.buffer, pointer, 2);
    Atomics.store(result, 0, isError ? 1 : 0);
    Atomics.store(result, 1, Number(value) | 0);
    Atomics.notify(result, 1, 1);
    return true;
  } catch {
    return false;
  }
}

export function finishThreadSpawn(
  wasmMemory: WebAssembly.Memory,
  errorOrTidPtr: number | undefined,
  tidOrErrno: number,
  isError = false,
): number {
  const usesResultPointer = errorOrTidPtr !== undefined;
  if (!usesResultPointer) {
    return isError ? -Math.abs(Number(tidOrErrno) || WASI_ERRNO_AGAIN) : tidOrErrno;
  }
  const value = Math.abs(Number(tidOrErrno) || WASI_ERRNO_AGAIN);
  const stored = storeThreadSpawnResult(wasmMemory, errorOrTidPtr, isError, value);
  return stored && !isError ? 0 : 1;
}

export function needsEnvMemoryImport(moduleImports: WebAssembly.ModuleImportDescriptor[]): boolean {
  return moduleImports.some(
    (descriptor) => descriptor.module === "env" && descriptor.name === "memory" && descriptor.kind === "memory",
  );
}

export function needsWasiThreadSpawnImport(moduleImports: WebAssembly.ModuleImportDescriptor[]): boolean {
  return moduleImports.some(
    (descriptor) =>
      descriptor.module === "wasi" && descriptor.name === "thread-spawn" && descriptor.kind === "function",
  );
}

export function createSharedThreadMemory({
  initialPages,
  maximumPages,
}: {
  initialPages?: unknown;
  maximumPages?: unknown;
} = {}): WebAssembly.Memory {
  const initial = normalizePositiveInteger(
    initialPages,
    DEFAULT_SHARED_MEMORY_INITIAL_PAGES,
    "sharedMemoryInitialPages",
  );
  const maximum = normalizePositiveInteger(maximumPages, DEFAULT_SHARED_MEMORY_MAX_PAGES, "sharedMemoryMaximumPages");
  if (maximum < initial) {
    throw new Error("sharedMemoryMaximumPages must be >= sharedMemoryInitialPages");
  }
  // Always seed the step-down ladder with the requested maximum as its top rung, whether it came from
  // the default or an explicit (mobile-ceiling) configuration. The ladder only ever steps DOWN
  // (`candidate < maximum`), so a configured cap is honored as a ceiling while still recovering on
  // constrained hosts (notably iOS, which reserves the full maximum's address range up front and may
  // refuse even the mobile 1 GiB ceiling - without a lower rung that would hard-OOM at warmup).
  const candidates = [
    maximum,
    ...FALLBACK_SHARED_MEMORY_MAX_PAGES.filter((candidate) => candidate < maximum && candidate >= initial),
  ];
  let allocationError: unknown = null;
  for (const candidate of candidates) {
    try {
      return new WebAssembly.Memory({ initial, maximum: candidate, shared: true });
    } catch (error) {
      if (!isSharedMemoryAllocationError(error)) throw error;
      allocationError = error;
    }
  }
  throw allocationError ?? new RangeError("failed to allocate shared wasm memory");
}

function isSharedMemoryAllocationError(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const rawMessage = isErrorLike(error) ? error.message : undefined;
  const message = String(rawMessage || "");
  return /\b(out of memory|allocation|reserve|could not allocate)\b/i.test(message);
}

function normalizePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}
