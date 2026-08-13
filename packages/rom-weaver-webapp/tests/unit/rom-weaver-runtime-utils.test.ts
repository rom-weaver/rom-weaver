import { describe, expect, it } from "vitest";
import {
  createJsonLineParser,
  createTraceJsonLineParser,
  createWasmEnvImports,
} from "../../src/wasm/rom-weaver-runtime-utils.ts";

describe("WASM JSON-line parsers", () => {
  it("keeps JSON events separate from non-JSON lines and ignores empty lines", () => {
    const events: Array<{ status: string }> = [];
    const nonJsonLines: string[] = [];
    const parser = createJsonLineParser({
      onEvent: (event) => events.push(event),
      onNonJsonLine: (line) => nonJsonLines.push(line),
    });

    parser.pushLine("");
    parser.pushLine('{"status":"running"}');
    parser.pushLine("wasm diagnostic");

    expect(parser.events).toEqual([{ status: "running" }]);
    expect(parser.nonJsonLines).toEqual(["wasm diagnostic"]);
    expect(events).toEqual([{ status: "running" }]);
    expect(nonJsonLines).toEqual(["wasm diagnostic"]);
  });

  it("records malformed trace lines while forwarding valid trace events", () => {
    const traceEvents: Array<{ stage: string }> = [];
    const traceNonJsonLines: string[] = [];
    const parser = createTraceJsonLineParser({
      onTraceEvent: (event) => traceEvents.push(event),
      onTraceNonJsonLine: (line) => traceNonJsonLines.push(line),
    });

    parser.pushLine('{"stage":"extract"}');
    parser.pushLine("trace without JSON");

    expect(parser.traceEvents).toEqual([{ stage: "extract" }]);
    expect(parser.traceNonJsonLines).toEqual(["trace without JSON"]);
    expect(traceEvents).toEqual([{ stage: "extract" }]);
    expect(traceNonJsonLines).toEqual(["trace without JSON"]);
  });
});

describe("WASM host-selection imports", () => {
  it("decodes requests, filters indices, and bounds multi-select writes", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const request = new TextEncoder().encode("choose a file");
    const requestPtr = 32;
    const outputPtr = 128;
    new Uint8Array(memory.buffer, requestPtr, request.byteLength).set(request);
    new Uint32Array(memory.buffer, outputPtr, 3).fill(0xffffffff);

    let receivedRequest = "";
    const imports = createWasmEnvImports(memory, (selectionRequest) => {
      receivedRequest = selectionRequest;
      return [2, -1, 1.5, Number.POSITIVE_INFINITY, 0, 7];
    });

    expect(imports.rom_weaver_host_select(requestPtr, request.byteLength)).toBe(2);
    expect(imports.rom_weaver_host_select_many(requestPtr, request.byteLength, outputPtr, 2)).toBe(2);
    expect(receivedRequest).toBe("choose a file");
    expect([...new Uint32Array(memory.buffer, outputPtr, 3)]).toEqual([2, 0, 0xffffffff]);
  });

  it("cancels on missing memory, invalid callbacks, and unreadable requests", () => {
    const noMemory = createWasmEnvImports(undefined, () => [1]);
    expect(noMemory.rom_weaver_host_select(0, 1)).toBe(-1);
    expect(noMemory.rom_weaver_host_select_many(0, 1, 0, 1)).toBe(0);

    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    let callbackCalls = 0;
    const unreadableRequest = createWasmEnvImports(memory, () => {
      callbackCalls += 1;
      return [1];
    });
    expect(unreadableRequest.rom_weaver_host_select(0, 0)).toBe(-1);
    expect(unreadableRequest.rom_weaver_host_select(memory.buffer.byteLength, 1)).toBe(-1);
    expect(callbackCalls).toBe(0);

    const nonArray = createWasmEnvImports(memory, () => ({ selected: 1 }) as never);
    expect(nonArray.rom_weaver_host_select(0, 1)).toBe(-1);

    const throwing = createWasmEnvImports(memory, () => {
      throw new Error("selection failed");
    });
    expect(throwing.rom_weaver_host_select(0, 1)).toBe(-1);
  });
});
