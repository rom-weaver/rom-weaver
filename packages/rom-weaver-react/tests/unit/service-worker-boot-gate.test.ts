import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createServiceWorkerBootGate } from "../../src/webapp/pwa/service-worker-boot-gate.ts";

const RELOAD_COUNT_KEY = "rom-weaver-coi-gate-reloads";
const STUCK_RELOAD_MS = 2000;
const TIMEOUT_MS = 10000;
const MAX_RELOADS = 3;

const createSessionStorage = (seed: Record<string, string> = {}) => {
  const state = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => (state.has(key) ? (state.get(key) ?? null) : null),
    removeItem: (key: string) => {
      state.delete(key);
    },
    setItem: (key: string, value: string) => {
      state.set(key, String(value));
    },
  };
};

const createHarness = ({
  crossOriginIsolated = false,
  controller = false,
  serviceWorkerEnabled = true,
  hasServiceWorker = true,
  sessionStorageSeed = {},
}: {
  crossOriginIsolated?: boolean;
  controller?: boolean;
  serviceWorkerEnabled?: boolean;
  hasServiceWorker?: boolean;
  sessionStorageSeed?: Record<string, string>;
} = {}) => {
  const flags = { controller, crossOriginIsolated };
  const reload = vi.fn();
  const sessionStorage = createSessionStorage(sessionStorageSeed);
  const serviceWorker = {
    addEventListener: vi.fn(),
    get controller() {
      return flags.controller ? ({} as ServiceWorker) : null;
    },
    removeEventListener: vi.fn(),
  };
  const browserWindow = {
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    get crossOriginIsolated() {
      return flags.crossOriginIsolated;
    },
    location: { reload },
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  };
  const gate = createServiceWorkerBootGate({
    logger: { debug: vi.fn(), trace: vi.fn() },
    maxReloads: MAX_RELOADS,
    navigator: hasServiceWorker ? { serviceWorker } : {},
    serviceWorkerEnabled,
    sessionStorage,
    stuckReloadMs: STUCK_RELOAD_MS,
    timeoutMs: TIMEOUT_MS,
    window: browserWindow,
  });

  return { flags, gate, reload, sessionStorage };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("boots immediately and is not gated when the document is already isolated", () => {
  const harness = createHarness({ crossOriginIsolated: true, sessionStorageSeed: { [RELOAD_COUNT_KEY]: "2" } });
  const onReady = vi.fn();

  expect(harness.gate.isGated()).toBe(false);
  harness.gate.start(onReady);

  expect(onReady).toHaveBeenCalledTimes(1);
  expect(harness.reload).not.toHaveBeenCalled();
  // reaching a good document resets the retry budget
  expect(harness.sessionStorage.getItem(RELOAD_COUNT_KEY)).toBeNull();
});

test("boots immediately when the service worker is disabled", () => {
  const harness = createHarness({ crossOriginIsolated: false, serviceWorkerEnabled: false });
  const onReady = vi.fn();

  expect(harness.gate.isGated()).toBe(false);
  harness.gate.start(onReady);

  expect(onReady).toHaveBeenCalledTimes(1);
  expect(harness.reload).not.toHaveBeenCalled();
});

test("holds the gate, then boots once the page becomes cross-origin isolated", () => {
  const harness = createHarness({ controller: true, crossOriginIsolated: false });
  const onReady = vi.fn();

  harness.gate.start(onReady);
  expect(harness.gate.isGated()).toBe(true);
  expect(onReady).not.toHaveBeenCalled();

  // Isolation arrives before the stuck window elapses.
  harness.flags.crossOriginIsolated = true;
  vi.advanceTimersByTime(400);

  expect(onReady).toHaveBeenCalledTimes(1);
  expect(harness.gate.isGated()).toBe(false);
  expect(harness.reload).not.toHaveBeenCalled();
  expect(harness.sessionStorage.getItem(RELOAD_COUNT_KEY)).toBeNull();
});

test("reloads to retry when controlled but not isolated past the stuck window", () => {
  const harness = createHarness({ controller: true, crossOriginIsolated: false });
  const onReady = vi.fn();

  harness.gate.start(onReady);
  vi.advanceTimersByTime(STUCK_RELOAD_MS);

  expect(harness.reload).toHaveBeenCalledTimes(1);
  expect(harness.sessionStorage.getItem(RELOAD_COUNT_KEY)).toBe("1");
  expect(onReady).not.toHaveBeenCalled();
  // renders stay suppressed across the reload
  expect(harness.gate.isGated()).toBe(true);
});

test("stops reloading and boots un-isolated once the retry budget is exhausted", () => {
  const harness = createHarness({
    controller: true,
    crossOriginIsolated: false,
    sessionStorageSeed: { [RELOAD_COUNT_KEY]: String(MAX_RELOADS) },
  });
  const onReady = vi.fn();

  harness.gate.start(onReady);
  vi.advanceTimersByTime(STUCK_RELOAD_MS);

  expect(harness.reload).not.toHaveBeenCalled();
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(harness.sessionStorage.getItem(RELOAD_COUNT_KEY)).toBeNull();
});

test("does not reload while still uncontrolled; boots at the absolute backstop", () => {
  const harness = createHarness({ controller: false, crossOriginIsolated: false });
  const onReady = vi.fn();

  harness.gate.start(onReady);

  // Past the stuck window but still uncontrolled: must not reload (a reload would not help install).
  vi.advanceTimersByTime(STUCK_RELOAD_MS + 1000);
  expect(harness.reload).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();

  // At the absolute backstop it boots un-isolated rather than hanging.
  vi.advanceTimersByTime(TIMEOUT_MS);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(harness.reload).not.toHaveBeenCalled();
});
