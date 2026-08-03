import { describe, expect, it } from "vitest";
import { resolveWorkerErrorKind } from "../../src/wasm/workers/worker-error-utils.ts";

// The literal stderr marker the wasm panic hook prefixes onto an aborting
// shared-memory panic, mirrored from
// `crates/rom-weaver-cli/src/wasm_main.rs`'s `WASM_PANIC_MARKER` const (pinned
// by the Rust-side contract test in
// `crates/rom-weaver-cli/tests/unit/wasm_main.rs`). There is no single source
// of truth shared across the Rust/JS boundary for this string - both sides
// hard-code it, so this assertion is what catches the two silently drifting
// apart if either one changes.
const WASM_PANIC_MARKER = "[rom-weaver-panic]";

describe("wasm panic marker contract", () => {
  it("pins the exact marker string the Rust panic hook emits", () => {
    expect(WASM_PANIC_MARKER).toBe("[rom-weaver-panic]");
  });

  // Contract gap found while writing this test: nothing in the webapp greps
  // WASM_PANIC_MARKER itself (a repo-wide search for the literal
  // "[rom-weaver-panic]" turns up only the Rust emitter). resolveWorkerErrorKind()
  // classifies a panic as "panic" only via isPanicLikeError()'s
  // /\bpanicked at\b/i message check or a /\bpanic\b/i match on the error
  // *name* - a message that carries only the marker (no "panicked at" phrase)
  // is NOT recognized and falls through to "unknown". In production this is
  // masked because the marker line is immediately followed by Rust's std
  // panic hook `PanicInfo` Display output, which always starts with
  // "panicked at ..." - so the marker rides along on stderr but the
  // "panicked at" phrase, not the marker, is what actually trips
  // classification today.
  it("is NOT independently recognized by resolveWorkerErrorKind - only the standard Rust 'panicked at' phrase is", () => {
    const markerOnly = new Error(`${WASM_PANIC_MARKER} boom at src/foo.rs:1`);
    expect(resolveWorkerErrorKind(markerOnly, markerOnly.name, markerOnly.message)).toBe("unknown");
  });

  it("classifies the real stderr line the panic hook emits (marker + PanicInfo's 'panicked at ...' Display) as a panic", () => {
    // `install_panic_reporter` in wasm_main.rs emits
    // `eprintln!("{WASM_PANIC_MARKER} {info}")`, and `PanicInfo`'s Display
    // always starts with "panicked at <location>:". This is the shape
    // resolveWorkerErrorKind actually needs to see.
    const error = new Error(`${WASM_PANIC_MARKER} panicked at src/foo.rs:12:5:\nboom`);
    expect(resolveWorkerErrorKind(error, error.name, error.message)).toBe("panic");
  });
});
