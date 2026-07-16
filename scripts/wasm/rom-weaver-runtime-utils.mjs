export function createWasmEnvImports(memory, hostSelect) {
  const ARCHIVE_FAILED = -25;
  const SELECT_CANCELLED = -1;
  const readHostSelectRequest = (requestPtr, requestLen) => {
    const activeMemory = imports.memory;
    if (!(activeMemory instanceof WebAssembly.Memory) || requestLen <= 0) {
      return null;
    }
    try {
      const bytes = new Uint8Array(activeMemory.buffer, requestPtr, requestLen).slice();
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  };
  const resolveHostSelection = (requestPtr, requestLen) => {
    if (typeof hostSelect !== 'function') return [];
    const request = readHostSelectRequest(requestPtr, requestLen);
    if (request === null) return [];
    try {
      const selected = hostSelect(request);
      const indices = Array.isArray(selected) ? selected : [selected];
      return indices.filter((index) => Number.isInteger(index) && index >= 0);
    } catch {
      return [];
    }
  };
  const writeHostSelectionIndices = (outIndicesPtr, outCapacity, indices) => {
    const activeMemory = imports.memory;
    if (!(activeMemory instanceof WebAssembly.Memory) || outCapacity <= 0 || indices.length === 0) return 0;
    try {
      const count = Math.min(indices.length, outCapacity);
      const view = new Uint32Array(activeMemory.buffer, outIndicesPtr, outCapacity);
      for (let slot = 0; slot < count; slot += 1) view[slot] = indices[slot];
      return count;
    } catch {
      return 0;
    }
  };
  const imports = {
    rom_weaver_host_select(requestPtr, requestLen) {
      const indices = resolveHostSelection(requestPtr, requestLen);
      return indices[0] ?? SELECT_CANCELLED;
    },
    rom_weaver_host_select_many(requestPtr, requestLen, outIndicesPtr, outCapacity) {
      return writeHostSelectionIndices(
        outIndicesPtr,
        outCapacity,
        resolveHostSelection(requestPtr, requestLen),
      );
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

export function normalizeGuestPath(pathLike, options = {}) {
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

export function createJsonLineParser(options = {}) {
  const events = [];
  const nonJsonLines = [];
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
        const event = JSON.parse(line);
        events.push(event);
        onEvent?.(event);
      } catch {
        nonJsonLines.push(line);
        onNonJsonLine?.(line);
      }
    },
  };
}

export function parseJsonLines(text, options = {}) {
  const parser = createJsonLineParser(options);

  for (const line of text.split(/\r?\n/)) {
    parser.pushLine(line);
  }

  return {
    events: parser.events,
    nonJsonLines: parser.nonJsonLines,
  };
}

export function createTraceJsonLineParser(options = {}) {
  const traceEvents = [];
  const traceNonJsonLines = [];
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
        const event = JSON.parse(line);
        traceEvents.push(event);
        onTraceEvent?.(event);
      } catch {
        traceNonJsonLines.push(line);
        onTraceNonJsonLine?.(line);
      }
    },
  };
}

export function parseTraceJsonLines(text, options = {}) {
  const parser = createTraceJsonLineParser(options);

  for (const line of text.split(/\r?\n/)) {
    parser.pushLine(line);
  }

  return {
    traceEvents: parser.traceEvents,
    traceNonJsonLines: parser.traceNonJsonLines,
  };
}
