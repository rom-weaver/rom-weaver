import type {
  ParseJsonLinesOptions,
  ParseJsonLinesResult,
  ParseTraceJsonLinesOptions,
  ParseTraceJsonLinesResult,
  RomWeaverRunJsonEvent,
} from "./rom-weaver-types.d.ts";

/** Resolves a wasm selection request to zero-based indices; an empty result means cancel. */
type HostSelectCallback = (request: string) => number[];

type WasmEnvImports = {
  __archive_write_program_allocate: () => number;
  __archive_write_program_close: () => number;
  __archive_write_program_free: () => number;
  __archive_write_program_open: () => number;
  __archive_write_program_write: () => number;
  __cxa_allocate_exception: () => number;
  __cxa_throw: (pointer: unknown, typeInfo: unknown) => never;
  rom_weaver_host_select: (requestPtr: number, requestLen: number) => number;
  rom_weaver_host_select_many: (
    requestPtr: number,
    requestLen: number,
    outIndicesPtr: number,
    outCapacity: number,
  ) => number;
  memory?: WebAssembly.Memory;
};

type JsonLineParser<TEvent> = ParseJsonLinesResult<TEvent> & {
  pushLine: (line: string) => void;
};

type TraceJsonLineParser<TTraceEvent> = ParseTraceJsonLinesResult<TTraceEvent> & {
  pushLine: (line: string) => void;
};

export function createWasmEnvImports(memory?: WebAssembly.Memory, hostSelect?: HostSelectCallback) {
  const ARCHIVE_FAILED = -25;
  const SELECT_CANCELLED = -1;
  const readHostSelectRequest = (requestPtr: number, requestLen: number): string | null => {
    const activeMemory = imports.memory;
    if (!(activeMemory instanceof WebAssembly.Memory) || requestLen <= 0) return null;
    try {
      const bytes = new Uint8Array(activeMemory.buffer, requestPtr, requestLen).slice();
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  };
  // Resolve a host-select request to the chosen 0-based indices, normalizing whatever the callback
  // returns into a clean integer list (empty == cancel). Shared by the single- and multi-select
  // imports so the two stay in lockstep.
  const resolveHostSelection = (requestPtr: number, requestLen: number): number[] => {
    if (typeof hostSelect !== "function") return [];
    const request = readHostSelectRequest(requestPtr, requestLen);
    if (request === null) return [];
    try {
      const selected = hostSelect(request);
      if (!Array.isArray(selected)) return [];
      return selected.filter((index) => Number.isInteger(index) && index >= 0);
    } catch {
      return [];
    }
  };
  // Write the chosen indices into the wasm-owned `u32` output buffer, bounded by its capacity, and
  // return the count written. The buffer view is taken fresh after the (blocking) host call so a
  // concurrent `memory.grow` on another thread cannot leave us writing through a detached buffer.
  const writeHostSelectionIndices = (outIndicesPtr: number, outCapacity: number, indices: number[]): number => {
    const activeMemory = imports.memory;
    if (!(activeMemory instanceof WebAssembly.Memory) || outCapacity <= 0 || indices.length === 0) {
      return 0;
    }
    try {
      const count = Math.min(indices.length, outCapacity);
      const view = new Uint32Array(activeMemory.buffer, outIndicesPtr, outCapacity);
      for (let slot = 0; slot < count; slot += 1) {
        view[slot] = indices[slot] as number;
      }
      return count;
    } catch {
      return 0;
    }
  };
  const imports: WasmEnvImports = {
    // Stub libarchive external-program filter hooks in browser runtimes.
    // Browser builds should use in-process codecs; if an external-program path
    // is selected, return failure instead of trapping on missing imports.
    __archive_write_program_allocate() {
      return 0;
    },
    __archive_write_program_close() {
      return ARCHIVE_FAILED;
    },
    __archive_write_program_free() {
      return ARCHIVE_FAILED;
    },
    __archive_write_program_open() {
      return ARCHIVE_FAILED;
    },
    __archive_write_program_write() {
      return ARCHIVE_FAILED;
    },
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(`rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`);
    },
    rom_weaver_host_select(requestPtr, requestLen) {
      const indices = resolveHostSelection(requestPtr, requestLen);
      // Single-select uses the first chosen index; an empty result (cancel / no handler) is -1.
      return indices.length > 0 ? (indices[0] as number) : SELECT_CANCELLED;
    },
    rom_weaver_host_select_many(requestPtr, requestLen, outIndicesPtr, outCapacity) {
      const indices = resolveHostSelection(requestPtr, requestLen);
      // An empty result means cancel; the wasm side treats a written count of 0 as cancelled.
      return writeHostSelectionIndices(outIndicesPtr, outCapacity, indices);
    },
  };

  if (memory instanceof WebAssembly.Memory) {
    imports.memory = memory;
  }

  return imports;
}

export function normalizeGuestPath(pathLike: unknown, options: { label?: string } = {}) {
  const label = typeof options.label === "string" && options.label.length > 0 ? options.label : "guest path";
  if (typeof pathLike !== "string" || pathLike.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  let normalized = pathLike.trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, "");
  }

  return normalized;
}

export function createJsonLineParser<TEvent = RomWeaverRunJsonEvent>(
  options: ParseJsonLinesOptions<TEvent> = {},
): JsonLineParser<TEvent> {
  const events: TEvent[] = [];
  const nonJsonLines: string[] = [];
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === "function" ? options.onNonJsonLine : null;

  return {
    events,
    nonJsonLines,
    pushLine(line) {
      if (line.length === 0) {
        return;
      }

      try {
        const event = JSON.parse(line) as TEvent;
        events.push(event);
        onEvent?.(event);
      } catch {
        nonJsonLines.push(line);
        onNonJsonLine?.(line);
      }
    },
  };
}

export function createTraceJsonLineParser<TTraceEvent = unknown>(
  options: ParseTraceJsonLinesOptions<TTraceEvent> = {},
): TraceJsonLineParser<TTraceEvent> {
  const traceEvents: TTraceEvent[] = [];
  const traceNonJsonLines: string[] = [];
  const onTraceEvent = typeof options.onTraceEvent === "function" ? options.onTraceEvent : null;
  const onTraceNonJsonLine = typeof options.onTraceNonJsonLine === "function" ? options.onTraceNonJsonLine : null;

  return {
    pushLine(line) {
      if (line.length === 0) {
        return;
      }

      try {
        const event = JSON.parse(line) as TTraceEvent;
        traceEvents.push(event);
        onTraceEvent?.(event);
      } catch {
        traceNonJsonLines.push(line);
        onTraceNonJsonLine?.(line);
      }
    },
    traceEvents,
    traceNonJsonLines,
  };
}
