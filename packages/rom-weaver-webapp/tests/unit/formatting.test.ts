import { describe, expect, it } from "vitest";
import { formatBytes, getByteUnitSystem, setByteUnitSystem } from "../../src/presentation/formatting/index.ts";

describe("formatBytes", () => {
  it("keeps decimal units as the default", () => {
    expect(formatBytes(1_000_000, "en")).toBe("1.0 MB");
  });

  it("formats binary units with IEC labels when selected", () => {
    expect(formatBytes(1_048_576, "en", "binary")).toBe("1.0 MiB");
  });

  it("uses the configured unit system when no explicit system is provided", () => {
    const previous = getByteUnitSystem();
    try {
      setByteUnitSystem("binary");
      expect(formatBytes(1024, "en")).toBe("1.0 KiB");
    } finally {
      setByteUnitSystem(previous);
    }
  });
});
