import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveWorkerErrorKind } from "../../src/wasm/workers/worker-error-utils.ts";

// Read the panic marker from Rust so this contract detects drift across the Rust/TypeScript boundary.
const WASM_MAIN_SOURCE = readFileSync(
  fileURLToPath(new URL("../../../../crates/rom-weaver-cli/src/wasm_main.rs", import.meta.url)),
  "utf8",
);

const markerMatch = WASM_MAIN_SOURCE.match(/const WASM_PANIC_MARKER:\s*&str\s*=\s*"([^"]*)";/);
if (!markerMatch) {
  throw new Error("Could not find WASM_PANIC_MARKER const in crates/rom-weaver-cli/src/wasm_main.rs");
}
const WASM_PANIC_MARKER = markerMatch[1] as string;

describe("wasm panic marker contract", () => {
  it("pins the exact marker string the Rust panic hook emits", () => {
    expect(WASM_PANIC_MARKER).toBe("[rom-weaver-panic]");
  });

  // The marker alone does not classify a generic Error as panic; the classifier also needs a recognized message or error name.
  it("is NOT independently recognized by resolveWorkerErrorKind - only the standard Rust 'panicked at' phrase is", () => {
    const markerOnly = new Error(`${WASM_PANIC_MARKER} boom at src/foo.rs:1`);
    expect(resolveWorkerErrorKind(markerOnly, markerOnly.name, markerOnly.message)).toBe("unknown");
  });

  it("classifies the real stderr line the panic hook emits (marker + PanicInfo's 'panicked at ...' Display) as a panic", () => {
    // The panic reporter includes the standard Rust panic text after its marker.
    const error = new Error(`${WASM_PANIC_MARKER} panicked at src/foo.rs:12:5:\nboom`);
    expect(resolveWorkerErrorKind(error, error.name, error.message)).toBe("panic");
  });
});
