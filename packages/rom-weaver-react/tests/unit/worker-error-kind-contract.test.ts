import { describe, expect, it } from "vitest";
import type { RomWeaverErrorKind } from "../../src/wasm/rom-weaver-types.d.ts";
import { resolveWorkerErrorKind } from "../../src/wasm/workers/worker-error-utils.ts";

// The canonical `Display` output prefix each RomWeaverError variant renders,
// mirrored from the Rust contract test in
// `crates/rom-weaver-core/tests/unit/error.rs`. resolveWorkerErrorKind() must
// classify each of these into the matching generated RomWeaverErrorKind via its
// inferCoreWorkerErrorKind() message regex. This locks the JS side to the same
// message-prefix => kind mapping the Rust side enforces; if a Rust `#[error]`
// prefix changes without updating both, one of these assertions breaks.
const CANONICAL_DISPLAY_TO_KIND: ReadonlyArray<[message: string, kind: RomWeaverErrorKind]> = [
  ["validation failed: bad header [E_BAD]", "validation"],
  ["unknown format for path `/tmp/mystery.bin`", "unknown_format"],
  ["unsupported operation: rust chd create currently supports only store mode", "unsupported"],
  ["operation cancelled", "cancelled"],
  ["i/o error: disk gone", "io"],
  ["thread pool build failed: no threads", "thread_pool_build"],
];

describe("worker-error kind contract", () => {
  it.each(
    CANONICAL_DISPLAY_TO_KIND,
  )("classifies %j as kind %j from the canonical Rust Display prefix", (message, kind) => {
    // A plain Error carries no explicit `kind`, so resolveWorkerErrorKind
    // falls through to message-prefix inference (the regex under test).
    const error = new Error(message);
    expect(resolveWorkerErrorKind(error, error.name, message)).toBe(kind);
  });

  it("prefers an explicit typed error kind over message-prefix inference", () => {
    // The Rust core attaches the generated RomWeaverErrorKind to a failed event
    // (propagated onto the thrown error as `kind`). resolveWorkerErrorKind must
    // trust that typed kind even when the message text would regex-classify
    // differently — this is what makes the typed kind the contract and the
    // inferCoreWorkerErrorKind regex a mere fallback.
    const unmatchable = Object.assign(new Error("totally unrelated text"), {
      kind: "validation",
    });
    expect(resolveWorkerErrorKind(unmatchable, unmatchable.name, unmatchable.message)).toBe("validation");

    // It also wins over a *contradicting* core message prefix.
    const contradicting = Object.assign(new Error("i/o error: disk gone"), {
      kind: "cancelled",
    });
    expect(resolveWorkerErrorKind(contradicting, contradicting.name, contradicting.message)).toBe("cancelled");
  });

  it("does not misclassify a non-core message as a core kind", () => {
    const message = "totally unrelated text";
    const error = new Error(message);
    const resolved = resolveWorkerErrorKind(error, error.name, message);
    const coreKinds: RomWeaverErrorKind[] = [
      "validation",
      "unknown_format",
      "unsupported",
      "cancelled",
      "io",
      "thread_pool_build",
    ];
    expect(coreKinds).not.toContain(resolved);
    expect(resolved).toBe("unknown");
  });
});
