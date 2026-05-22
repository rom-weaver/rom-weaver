export function createWasmEnvImports(memoryOrOptions, maybeOptions = {}) {
  const { memory, module } = normalizeCreateWasmEnvImportOptions(memoryOrOptions, maybeOptions);
  const imports = {
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(
        `rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`,
      );
    },
  };

  if (memory instanceof WebAssembly.Memory) {
    imports.memory = memory;
  }

  if (module instanceof WebAssembly.Module) {
    const descriptors = WebAssembly.Module.imports(module);
    for (const descriptor of descriptors) {
      if (descriptor.module !== 'env' || descriptor.kind !== 'function') {
        continue;
      }
      if (typeof imports[descriptor.name] === 'function') {
        continue;
      }
      imports[descriptor.name] = function unresolvedEnvImportNoop() {
        return 0;
      };
    }
  }

  return imports;
}

function normalizeCreateWasmEnvImportOptions(memoryOrOptions, maybeOptions) {
  if (
    memoryOrOptions
    && typeof memoryOrOptions === 'object'
    && !(memoryOrOptions instanceof WebAssembly.Memory)
    && !(memoryOrOptions instanceof WebAssembly.Module)
  ) {
    return {
      memory: memoryOrOptions.memory,
      module: memoryOrOptions.module,
    };
  }

  return {
    memory: memoryOrOptions,
    module: maybeOptions?.module,
  };
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

export function parseJsonLines(text, options = {}) {
  const events = [];
  const nonJsonLines = [];
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === 'function'
    ? options.onNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

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
  const onTraceEvent = typeof options.onTraceEvent === 'function' ? options.onTraceEvent : null;
  const onTraceNonJsonLine = typeof options.onTraceNonJsonLine === 'function'
    ? options.onTraceNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

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
