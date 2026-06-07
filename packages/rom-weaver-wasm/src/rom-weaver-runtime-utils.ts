import type {
  ParseJsonLinesOptions,
  ParseJsonLinesResult,
  ParseTraceJsonLinesOptions,
  ParseTraceJsonLinesResult,
  RomWeaverRunJsonEvent,
} from './rom-weaver-types.d.ts';

/**
 * Host selection callback. The wasm app calls `rom_weaver_host_select(requestPtr, requestLen)` with
 * a UTF-8 JSON request (`{heading, candidates:[{value,label}]}`) and expects the chosen 0-based
 * index back, or a negative value to cancel. The runner supplies an implementation that blocks the
 * worker until the UI resolves the pick; when no handler is registered it returns -1 (cancel),
 * matching the historical non-interactive behavior.
 */
type HostSelectCallback = (request: string) => number;

type WasmEnvImports = {
  __archive_write_program_allocate: () => number;
  __archive_write_program_close: () => number;
  __archive_write_program_free: () => number;
  __archive_write_program_open: () => number;
  __archive_write_program_write: () => number;
  __cxa_allocate_exception: () => number;
  __cxa_throw: (pointer: unknown, typeInfo: unknown) => never;
  rom_weaver_host_select: (requestPtr: number, requestLen: number) => number;
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
  const imports: WasmEnvImports = {
    rom_weaver_host_select(requestPtr, requestLen) {
      if (typeof hostSelect !== "function") return SELECT_CANCELLED;
      const request = readHostSelectRequest(requestPtr, requestLen);
      if (request === null) return SELECT_CANCELLED;
      try {
        const selected = hostSelect(request);
        return Number.isInteger(selected) ? selected : SELECT_CANCELLED;
      } catch {
        return SELECT_CANCELLED;
      }
    },
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(
        `rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`,
      );
    },
    // Stub libarchive external-program filter hooks in browser runtimes.
    // Browser builds should use in-process codecs; if an external-program path
    // is selected, return failure instead of trapping on missing imports.
    __archive_write_program_allocate() {
      return 0;
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
    __archive_write_program_close() {
      return ARCHIVE_FAILED;
    },
  };

  if (memory instanceof WebAssembly.Memory) {
    imports.memory = memory;
  }

  return imports;
}

export function normalizeGuestPath(pathLike: unknown, options: { label?: string } = {}) {
  const label = typeof options.label === 'string' && options.label.length > 0
    ? options.label
    : 'guest path';
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  let normalized = pathLike.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
}

export function createJsonLineParser<TEvent = RomWeaverRunJsonEvent>(
  options: ParseJsonLinesOptions<TEvent> = {},
): JsonLineParser<TEvent> {
  const events: TEvent[] = [];
  const nonJsonLines: string[] = [];
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === 'function'
    ? options.onNonJsonLine
    : null;

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
  const onTraceEvent = typeof options.onTraceEvent === 'function' ? options.onTraceEvent : null;
  const onTraceNonJsonLine = typeof options.onTraceNonJsonLine === 'function'
    ? options.onTraceNonJsonLine
    : null;

  return {
    traceEvents,
    traceNonJsonLines,
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
  };
}
