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
