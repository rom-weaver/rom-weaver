// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // installLogStore chains the real console sink, so the thousands of pushes
  // below would otherwise land in CI output verbatim. Nothing here asserts on
  // console.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

/**
 * Boot records (info, debug, trace) wait for the first idle moment so their
 * sanitize and sink work leaves the path to hydration; none may be lost.
 */
describe("log store boot deferral", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a boot info record out of the store until idle, then stores it once, in order", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logging = await import("../../src/lib/logging.ts");
    const store = await import("../../src/webapp/log-store.ts");
    logging.configureLogger({ level: "info" });
    store.installLogStore();
    const log = logging.createLogger("boot-test");
    log.info("early one");
    log.info("early two");
    expect(store.getLogEntries().map((entry) => entry.message)).toEqual([]);
    vi.advanceTimersByTime(2500);
    expect(store.getLogEntries().map((entry) => entry.message)).toEqual(["early one", "early two"]);
    log.info("after boot");
    expect(store.getLogEntries().at(-1)?.message).toBe("after boot");
    vi.unstubAllGlobals();
  });

  it("flushes queued boot records on pagehide and puts a warning after them", async () => {
    vi.resetModules();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logging = await import("../../src/lib/logging.ts");
    const store = await import("../../src/webapp/log-store.ts");
    logging.configureLogger({ level: "info" });
    store.installLogStore();
    const log = logging.createLogger("boot-test");
    log.info("queued");
    log.warn("immediate");
    expect(store.getLogEntries().map((entry) => entry.message)).toEqual(["queued", "immediate"]);
    log.info("queued again");
    window.dispatchEvent(new Event("pagehide"));
    expect(store.getLogEntries().at(-1)?.message).toBe("queued again");
    expect(
      JSON.parse(localStorage.getItem("currentLog") || "[]").map((entry: { message: string }) => entry.message),
    ).toEqual(["queued", "immediate", "queued again"]);
    vi.unstubAllGlobals();
  });

  it("delivers queued boot records as soon as a reader subscribes, then stops deferring", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logging = await import("../../src/lib/logging.ts");
    const store = await import("../../src/webapp/log-store.ts");
    logging.configureLogger({ level: "info" });
    store.installLogStore();
    const log = logging.createLogger("boot-test");
    log.info("before the dialog opens");
    expect(store.getLogEntries()).toEqual([]);
    const unsubscribe = store.subscribeLogEntries(() => undefined);
    expect(store.getLogEntries().map((entry) => entry.message)).toEqual(["before the dialog opens"]);
    log.info("while it is open");
    expect(store.getLogEntries().at(-1)?.message).toBe("while it is open");
    unsubscribe();
    vi.unstubAllGlobals();
  });
});
