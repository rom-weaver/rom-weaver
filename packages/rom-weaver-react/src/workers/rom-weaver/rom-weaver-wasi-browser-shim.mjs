const JSON_LINE_SPLIT_REGEX = /\r?\n/;

const asFunction = (value) => (typeof value === "function" ? value : null);

export function createWasmEnvImports(memory) {
  const imports = {
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(`rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`);
    },
  };

  if (memory instanceof WebAssembly.Memory) imports.memory = memory;
  return imports;
}

export function createRomWeaverWasiRunner() {
  throw new Error("createRomWeaverWasiRunner is unavailable in browser builds; use rom-weaver browser worker mode.");
}

export function parseJsonLines(text, options = {}) {
  const events = [];
  const nonJsonLines = [];
  const onEvent = asFunction(options.onEvent);
  const onNonJsonLine = asFunction(options.onNonJsonLine);
  for (const line of String(text || "").split(JSON_LINE_SPLIT_REGEX)) {
    if (!line.length) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event);
    } catch {
      nonJsonLines.push(line);
      onNonJsonLine?.(line);
    }
  }
  return { events, nonJsonLines };
}

export function parseTraceJsonLines(text, options = {}) {
  const traceEvents = [];
  const traceNonJsonLines = [];
  const onTraceEvent = asFunction(options.onTraceEvent);
  const onTraceNonJsonLine = asFunction(options.onTraceNonJsonLine);
  for (const line of String(text || "").split(JSON_LINE_SPLIT_REGEX)) {
    if (!line.length) continue;
    try {
      const event = JSON.parse(line);
      traceEvents.push(event);
      onTraceEvent?.(event);
    } catch {
      traceNonJsonLines.push(line);
      onTraceNonJsonLine?.(line);
    }
  }
  return { traceEvents, traceNonJsonLines };
}
