// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetThreadWorkerLoadProbe,
  describeThreadWorkerErrorEvent,
  probeThreadWorkerLoadFailure,
} from "../../src/wasm/browser-wasi-thread-load-probe.ts";

/**
 * A thread worker that fails to load arrives as an empty event, so these probes are the only
 * evidence of *why*. They hang off an already-failing path, so the contract is: report once, never
 * throw, never block.
 */

const WORKER_URL = "https://rom-weaver.test/assets/browser-wasi-thread-worker-Test1234.js";

const collectTrace = () => {
  const lines: string[] = [];
  return { lines, trace: (line: string) => lines.push(line) };
};

const waitForTraceLine = async (lines: string[], fragment: string) => {
  await vi.waitFor(() => {
    expect(lines.join("\n")).toContain(fragment);
  });
};

describe("describeThreadWorkerErrorEvent", () => {
  it("marks a bare Event as a load failure rather than a thrown error", () => {
    const described = describeThreadWorkerErrorEvent(new Event("error"));
    expect(described).toContain("isErrorEvent=false");
    expect(described).toContain("hasErrorObject=false");
    expect(described).toContain("eventType=error");
  });

  it("marks a populated ErrorEvent as code that ran and threw", () => {
    const described = describeThreadWorkerErrorEvent(
      new ErrorEvent("error", { error: new Error("boom"), message: "boom" }),
    );
    expect(described).toContain("isErrorEvent=true");
    expect(described).toContain("hasErrorObject=true");
  });
});

describe("probeThreadWorkerLoadFailure", () => {
  beforeEach(() => {
    __resetThreadWorkerLoadProbe();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the status, headers and body prefix the host actually served", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response("<!doctype html><title>rom-weaver</title>", {
            headers: { "content-type": "text/html" },
            status: 200,
          }),
        ),
      ),
    );
    const { lines, trace } = collectTrace();

    probeThreadWorkerLoadFailure(WORKER_URL, trace);

    // An SPA fallback served in place of the worker script is exactly the shape this must surface.
    await waitForTraceLine(lines, "contentType=text/html");
    expect(lines.join("\n")).toContain("status=200");
    expect(lines.join("\n")).toContain("<!doctype html>");
  });

  it("runs once per runtime so a pool retry storm cannot spam the trace", async () => {
    const fetchMock = vi.fn(async () => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);
    const { lines, trace } = collectTrace();

    probeThreadWorkerLoadFailure(WORKER_URL, trace);
    probeThreadWorkerLoadFailure(WORKER_URL, trace);
    probeThreadWorkerLoadFailure(WORKER_URL, trace);

    await waitForTraceLine(lines, "thread worker probe done");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines.filter((line) => line.includes("thread worker probe start"))).toHaveLength(1);
  });

  it("still finishes when the fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    const { lines, trace } = collectTrace();

    probeThreadWorkerLoadFailure(WORKER_URL, trace);

    await waitForTraceLine(lines, "probe fetch threw");
    await waitForTraceLine(lines, "thread worker probe done");
  });

  it("does nothing without a trace sink", () => {
    const fetchMock = vi.fn(async () => Promise.resolve(new Response("ok")));
    vi.stubGlobal("fetch", fetchMock);

    probeThreadWorkerLoadFailure(WORKER_URL, undefined);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
