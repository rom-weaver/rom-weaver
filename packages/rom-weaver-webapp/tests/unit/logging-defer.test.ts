import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogRecord } from "../../src/types/logging.ts";

const loadLogging = async () => {
  vi.resetModules();
  return import("../../src/lib/logging.ts");
};

describe("deferred log records", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues info records until flushed, keeping order, timestamp and sanitized details", async () => {
    const { configureLogger, createLogger, deferLogRecords, flushDeferredLogs } = await loadLogging();
    const delivered: LogRecord[] = [];
    configureLogger({ level: "trace", sink: (record) => delivered.push(record) });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const log = createLogger("boot");
    deferLogRecords();
    log.info("first", { filePath: "/a/b/rom.nes" });
    log.trace("second");
    expect(delivered).toEqual([]);
    vi.setSystemTime(new Date("2026-01-02T03:04:09.000Z"));
    flushDeferredLogs();
    expect(delivered.map((record) => record.message)).toEqual(["first", "second"]);
    expect(delivered[0]).toEqual({
      details: { filePath: "rom.nes" },
      level: "info",
      message: "first",
      namespace: "boot",
      timestamp: "2026-01-02T03:04:05.000Z",
    });
    log.info("third");
    expect(delivered.map((record) => record.message)).toEqual(["first", "second", "third"]);
  });

  it("delivers warnings and errors at once, after the records queued before them", async () => {
    const { configureLogger, createLogger, deferLogRecords } = await loadLogging();
    const delivered: string[] = [];
    configureLogger({ level: "trace", sink: (record) => delivered.push(`${record.level}:${record.message}`) });
    const log = createLogger("boot");
    deferLogRecords();
    log.info("queued");
    log.error("boom");
    expect(delivered).toEqual(["info:queued", "error:boom"]);
    log.debug("later");
    log.warn("careful");
    expect(delivered).toEqual(["info:queued", "error:boom", "debug:later", "warn:careful"]);
  });

  it("drops records below the configured level instead of queueing them", async () => {
    const { configureLogger, createLogger, deferLogRecords, flushDeferredLogs } = await loadLogging();
    const delivered: string[] = [];
    configureLogger({ level: "warn", sink: (record) => delivered.push(record.message) });
    deferLogRecords();
    createLogger("boot").info("hidden");
    flushDeferredLogs();
    expect(delivered).toEqual([]);
  });

  it("keeps order when a sink logs while the queue drains", async () => {
    const { configureLogger, createLogger, deferLogRecords, flushDeferredLogs } = await loadLogging();
    const delivered: string[] = [];
    const log = createLogger("boot");
    configureLogger({
      level: "trace",
      sink: (record) => {
        delivered.push(record.message);
        if (record.message === "a") log.info("from-sink");
      },
    });
    deferLogRecords();
    log.info("a");
    log.info("b");
    flushDeferredLogs();
    expect(delivered).toEqual(["a", "b", "from-sink"]);
  });
});
