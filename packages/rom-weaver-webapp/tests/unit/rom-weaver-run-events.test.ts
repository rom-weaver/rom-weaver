import { describe, expect, it } from "vitest";
import type { RomWeaverRunJsonEvent } from "../../src/wasm/index.ts";
import { getRomWeaverRunEventErrorKind } from "../../src/workers/rom-weaver/rom-weaver-run-events.ts";

// The typed `error_kind` is the Rust-side contract (the generated
// RomWeaverErrorKind) that lets the webapp classify a failure without
// re-deriving the kind from the message. These lock the reader to that field.
describe("getRomWeaverRunEventErrorKind", () => {
  it("reads the typed error_kind from a failed event", () => {
    const event = {
      error_kind: "validation",
      label: "validation failed: bad header",
      status: "failed",
    } as unknown as RomWeaverRunJsonEvent;
    expect(getRomWeaverRunEventErrorKind(event)).toBe("validation");
  });

  it("is nullish when the event carries no typed error kind", () => {
    const running = { label: "working", status: "running" } as unknown as RomWeaverRunJsonEvent;
    expect(getRomWeaverRunEventErrorKind(running)).toBeUndefined();

    // A failure with no classified kind (e.g. a context-wrapped message) leaves
    // the field absent, so the caller falls back to message inference.
    const unclassified = {
      label: "failed to prepare output path `/x`: operation cancelled",
      status: "failed",
    } as unknown as RomWeaverRunJsonEvent;
    expect(getRomWeaverRunEventErrorKind(unclassified) ?? undefined).toBeUndefined();
  });
});
