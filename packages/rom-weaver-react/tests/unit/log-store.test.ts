// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { LogRecord } from "../../src/types/logging.ts";
import { parseRustTraceRecord } from "../../src/webapp/log-store.ts";

/**
 * Rust `tracing` lines arrive embedded in log messages; the log dialog's
 * caller column depends on this parse to show the actual Rust target.
 */

const record = (message: string): LogRecord =>
  ({ level: "trace", message, namespace: "runtime:rom-weaver", timestamp: "2026-06-12T00:00:00.000Z" }) as LogRecord;

describe("parseRustTraceRecord", () => {
  it("re-attributes a rust tracing line to its target", () => {
    const parsed = parseRustTraceRecord(
      record("2026-06-12T23:54:42.544000Z TRACE rom_weaver_core::context: planning thread usage budget=10"),
    );
    expect(parsed.namespace).toBe("rom_weaver_core::context");
    expect(parsed.level).toBe("trace");
    expect(parsed.message).toBe("planning thread usage budget=10");
    expect(parsed.timestamp).toBe("2026-06-12T23:54:42.544000Z");
  });

  it("maps rust levels and keeps multi-line payloads", () => {
    const parsed = parseRustTraceRecord(record("2026-06-12T00:00:01Z WARN rom_weaver_app: fallback\nsecond line"));
    expect(parsed.level).toBe("warn");
    expect(parsed.namespace).toBe("rom_weaver_app");
    expect(parsed.message).toBe("fallback\nsecond line");
  });

  it("leaves ordinary records untouched", () => {
    const plain = record("thread pool command post worker=12 id=1");
    expect(parseRustTraceRecord(plain)).toEqual(plain);
  });
});
