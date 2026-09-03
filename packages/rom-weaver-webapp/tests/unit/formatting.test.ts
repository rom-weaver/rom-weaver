import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatList,
  getByteUnitSystem,
  normalizeByteUnitSystem,
  setByteUnitSystem,
} from "../../src/presentation/formatting/index.ts";

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

  it("normalizes unsupported unit systems and invalid byte counts", () => {
    expect(normalizeByteUnitSystem("binary")).toBe("binary");
    expect(normalizeByteUnitSystem("iec")).toBe("decimal");
    expect(formatBytes(-1, "en")).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY, "en")).toBe("0 B");
  });

  it("caps the unit scale at tebibytes", () => {
    expect(formatBytes(1024 ** 6, "en", "binary")).toBe("1,048,576.0 TiB");
  });
});

describe("localized scalar formatting", () => {
  it("formats millisecond and second durations", () => {
    expect(formatDuration(-1, "en")).toBe("0ms");
    expect(formatDuration(999.6, "en")).toBe("1,000ms");
    expect(formatDuration(1500, "en")).toBe("1.50s");
  });

  it("formats bare, singular, and plural counts", () => {
    expect(formatCount(1200, "en")).toBe("1,200");
    expect(formatCount(1, "en", "file")).toBe("1 file");
    expect(formatCount(2, "en", "file")).toBe("2 files");
  });

  it("uses the platform list formatter", () => {
    expect(formatList(["IPS", "BPS", "PPF"], "en")).toBe("IPS, BPS, and PPF");
  });

  it("keeps readable list punctuation without Intl.ListFormat", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "ListFormat");
    Object.defineProperty(Intl, "ListFormat", { configurable: true, value: undefined });
    try {
      expect(formatList(["IPS", "BPS"], "en")).toBe("IPS and BPS");
      expect(formatList(["IPS", "BPS", "PPF"], "en")).toBe("IPS, BPS, and PPF");
    } finally {
      if (descriptor) Object.defineProperty(Intl, "ListFormat", descriptor);
    }
  });
});
