// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/lib/logging.ts";
import type { LogRecord } from "../../src/types/logging.ts";
import {
  getLogEntries,
  installLogStore,
  parseRustTraceRecord,
  subscribeLogEntries,
} from "../../src/webapp/log-store.ts";

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

/**
 * The buffer is the browser hot path under trace logging: pushes must stay
 * cheap (no synchronous React notify per line) and bounded (capped ring).
 */
describe("log store buffer", () => {
  it("coalesces notifications instead of firing one per push", () => {
    installLogStore();
    let notifications = 0;
    const unsubscribe = subscribeLogEntries(() => {
      notifications += 1;
    });
    const log = createLogger("test-buffer");
    for (let i = 0; i < 50; i += 1) log.warn(`line ${i}`);
    // The flush is deferred to the next frame, so a burst of pushes notifies
    // listeners zero times synchronously rather than once per line.
    expect(notifications).toBe(0);
    unsubscribe();
  });

  it("caps the buffer and keeps the newest lines in order", () => {
    installLogStore();
    const log = createLogger("test-buffer");
    // Mirrors MAX_LOG_LINES in src/webapp/log-store.ts (the constant is
    // module-private, so keep this literal in sync if the cap changes).
    const maxLogLines = 2500;
    const pushed = maxLogLines + 150;
    for (let i = 0; i < pushed; i += 1) log.warn(`entry ${i}`);
    const entries = getLogEntries();
    expect(entries.length).toBe(maxLogLines);
    // Oldest lines are dropped: the first kept entry is the (pushed - cap)th.
    expect(entries[0]?.message).toBe(`entry ${pushed - maxLogLines}`);
    expect(entries.at(-1)?.message).toBe(`entry ${pushed - 1}`);
  });
});
