// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../src/webapp/build-version.ts";
import { isNewRelease, resolveUpdatedSince, writeLastSeenVersion } from "../../src/webapp/last-seen-version.ts";

const KEY = "rom-weaver-last-seen-version";
const NEWER = `${Number.parseInt(APP_VERSION, 10) + 1}.0.0`;
// Both sort below any version the package will carry.
const OLDER = "0.0.1";
const OLDEST = "0.0.0";

const controlPage = (controlled: boolean) =>
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { controller: controlled ? {} : null },
  });

beforeEach(() => {
  window.localStorage.clear();
  controlPage(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUpdatedSince", () => {
  it("records a first visit without announcing anything", () => {
    expect(resolveUpdatedSince()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION);
  });

  it("announces the update from the version last seen", () => {
    window.localStorage.setItem(KEY, OLDER);

    expect(resolveUpdatedSince()).toEqual({ from: OLDER });
    // Only acknowledging the notice moves the record forward.
    expect(window.localStorage.getItem(KEY)).toBe(OLDER);
  });

  it("stays quiet on the version already seen", () => {
    window.localStorage.setItem(KEY, APP_VERSION);

    expect(resolveUpdatedSince()).toBeNull();
  });

  it("stays quiet after a rollback and keeps the newer record", () => {
    window.localStorage.setItem(KEY, NEWER);

    expect(resolveUpdatedSince()).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBe(NEWER);
  });

  it("announces the running release to a returning visitor with no record", () => {
    controlPage(true);

    expect(resolveUpdatedSince()).toEqual({});
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("announces nothing when storage is unavailable", () => {
    controlPage(true);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage denied");
      },
    });

    expect(resolveUpdatedSince()).toBeNull();
  });
});

describe("writeLastSeenVersion", () => {
  it("records the running version", () => {
    window.localStorage.setItem(KEY, OLDER);

    writeLastSeenVersion();

    expect(window.localStorage.getItem(KEY)).toBe(APP_VERSION);
  });

  it("records a newer release read about before reloading into it", () => {
    writeLastSeenVersion(NEWER);

    expect(window.localStorage.getItem(KEY)).toBe(NEWER);
  });

  it("never moves the record backwards", () => {
    window.localStorage.setItem(KEY, NEWER);

    writeLastSeenVersion();

    expect(window.localStorage.getItem(KEY)).toBe(NEWER);
  });
});

describe("isNewRelease", () => {
  it("counts the releases after the one last seen, up to the running one", () => {
    expect(isNewRelease(APP_VERSION, { from: OLDEST })).toBe(true);
    expect(isNewRelease(OLDER, { from: OLDEST })).toBe(true);
    expect(isNewRelease(OLDEST, { from: OLDEST })).toBe(false);
    expect(isNewRelease(NEWER, { from: OLDEST })).toBe(false);
  });

  it("compares versions numerically rather than as text", () => {
    expect(isNewRelease("0.0.10", { from: "0.0.9" })).toBe(true);
    expect(isNewRelease("0.0.9", { from: "0.0.10" })).toBe(false);
  });

  it("counts only the running release when no earlier version was recorded", () => {
    expect(isNewRelease(APP_VERSION, {})).toBe(true);
    expect(isNewRelease(OLDER, {})).toBe(false);
  });
});
