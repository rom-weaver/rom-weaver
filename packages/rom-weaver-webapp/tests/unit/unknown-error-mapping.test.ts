import { describe, expect, it } from "vitest";
import { toRomWeaverError } from "../../src/lib/errors.ts";
import { formatCodedErrorForDisplay } from "../../src/presentation/errors.ts";

// An unrecognised failure used to be coded INVALID_INPUT, which told the user
// their file was bad and sent them re-dumping a ROM that was fine. It now codes
// UNKNOWN and points at the log.

describe("unknown error mapping", () => {
  it("codes an unrecognised message UNKNOWN", () => {
    expect(toRomWeaverError(new Error("something inexplicable happened")).code).toBe("UNKNOWN");
  });

  it("keeps the codes it can still recognise", () => {
    expect(toRomWeaverError(new Error("checksum did not match")).code).toBe("CHECKSUM_MISMATCH");
    expect(toRomWeaverError(new Error("no patch was supplied")).code).toBe("INVALID_INPUT");
  });

  it("leads the display text with the message, not the code", () => {
    const display = formatCodedErrorForDisplay(toRomWeaverError(new Error("something inexplicable happened")));
    expect(display.startsWith("UNKNOWN")).toBe(false);
    expect(display).toContain("failed unexpectedly");
    expect(display).toContain("Logs");
  });

  it("appends the remediation hint for a checksum mismatch", () => {
    const display = formatCodedErrorForDisplay(toRomWeaverError(new Error("checksum did not match")));
    expect(display).toContain("region or revision");
  });
});
