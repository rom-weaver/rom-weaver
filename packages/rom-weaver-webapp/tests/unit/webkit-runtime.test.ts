import { describe, expect, it } from "vitest";
import {
  hasChromeToken,
  hasIosDeviceToken,
  hasMobileToken,
  hasSafariToken,
  isAppleMobileWebKit,
  isAppleTouchDesktop,
  isSafariBrowser,
  isWebKitDesktopSafari,
  type WebKitRuntimeEnvironment,
} from "@rom-weaver/wasm";
import { getFileInputAcceptAttributes } from "../../src/public/react/file-input-accept.ts";

/**
 * Pins WebKit/Safari behavior against the pre-centralization predicates below.
 *
 * Call sites intentionally classify some UAs differently. Expected values come
 * from these original predicates, keeping the table independent:
 *   site 1 - isMobileSafariLike (browser-runtime-diagnostics.ts)
 *   site 2 - isMobileSafari (file-input-accept.ts)
 *   site 3 - isWebKitInputRuntime (browser-opfs-source-ref.ts)
 */

const SAFARI_TOKEN = /Safari/;
const MOBILE_TOKEN = /Mobile(\/\S+)? /;

const originalIsMobileSafariLike = (ua: string, platform: string, maxTouchPoints: number) => {
  const isSafari = SAFARI_TOKEN.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS)/.test(ua);
  const isMobile = MOBILE_TOKEN.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
  return isSafari && isMobile;
};

const originalIsMobileSafari = (ua: string, platform: string, maxTouchPoints: number) => {
  const isSafari = SAFARI_TOKEN.test(ua) && !/Chrome/.test(ua);
  const isMobile = MOBILE_TOKEN.test(ua) || (isSafari && platform === "MacIntel" && maxTouchPoints > 1);
  return isSafari && isMobile;
};

const originalIsWebKitInputRuntime = (ua: string, platform: string, maxTouchPoints: number) => {
  if (!ua) return false;
  const isAppleMobile = /iP(hone|ad|od)/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
  const isDesktopSafari = SAFARI_TOKEN.test(ua) && !/(Chrome|Chromium|Edg|OPR|SamsungBrowser)/.test(ua);
  return isAppleMobile || isDesktopSafari;
};

// How each site is composed from the shared primitives now. These must mirror
// the production call sites; the assertions below prove they equal the
// originals for every UA in the matrix.
const composedSite1 = (environment: WebKitRuntimeEnvironment) =>
  isSafariBrowser(environment) && (hasMobileToken(environment) || isAppleTouchDesktop(environment));

const composedSite2 = (environment: WebKitRuntimeEnvironment) => {
  const isSafari = hasSafariToken(environment) && !hasChromeToken(environment);
  const isMobile = hasMobileToken(environment) || (isSafari && isAppleTouchDesktop(environment));
  return isSafari && isMobile;
};

const composedSite3 = (environment: WebKitRuntimeEnvironment) => {
  if (!environment.userAgent) return false;
  return isAppleMobileWebKit(environment) || isWebKitDesktopSafari(environment);
};

type RuntimeCase = {
  name: string;
  env: Required<WebKitRuntimeEnvironment>;
  primitives: {
    hasSafariToken: boolean;
    hasChromeToken: boolean;
    hasIosDeviceToken: boolean;
    hasMobileToken: boolean;
    isAppleTouchDesktop: boolean;
    isSafariBrowser: boolean;
    isWebKitDesktopSafari: boolean;
    isAppleMobileWebKit: boolean;
  };
  site1: boolean;
  site2: boolean;
  site3: boolean;
};

// Representative UA matrix. `site1`/`site2`/`site3` and every primitive value
// below were derived from the original logic above (not from the new module).
const CASES: RuntimeCase[] = [
  {
    env: {
      maxTouchPoints: 0,
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    },
    name: "desktop Safari (macOS)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: false,
      hasMobileToken: false,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: true,
      isWebKitDesktopSafari: true,
    },
    site1: false,
    site2: false,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    },
    name: "iOS Safari (iPhone)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: true,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: true,
      isAppleTouchDesktop: false,
      isSafariBrowser: true,
      isWebKitDesktopSafari: true,
    },
    site1: true,
    site2: true,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 5,
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    },
    name: "iPadOS Safari (MacIntel + touch desktop mode)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: false,
      hasMobileToken: false,
      hasSafariToken: true,
      isAppleMobileWebKit: true,
      isAppleTouchDesktop: true,
      isSafariBrowser: true,
      isWebKitDesktopSafari: true,
    },
    site1: true,
    site2: true,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1",
    },
    name: "iOS Chrome (CriOS)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: true,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: true,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: true,
    },
    site1: false,
    site2: true,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15",
    },
    name: "iOS Firefox (FxiOS)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: true,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: true,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: true,
    },
    site1: false,
    site2: true,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "iPhone",
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 EdgiOS/123.0.2420.65 Mobile/15E148 Safari/604.1",
    },
    name: "iOS Edge (EdgiOS)",
    primitives: {
      hasChromeToken: false,
      hasIosDeviceToken: true,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: true,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: true,
    site3: true,
  },
  {
    env: {
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
    },
    name: "Android Chrome",
    primitives: {
      hasChromeToken: true,
      hasIosDeviceToken: false,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: false,
    site3: false,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    },
    name: "desktop Chrome",
    primitives: {
      hasChromeToken: true,
      hasIosDeviceToken: false,
      hasMobileToken: false,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: false,
    site3: false,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65",
    },
    name: "desktop Edge (Edg)",
    primitives: {
      hasChromeToken: true,
      hasIosDeviceToken: false,
      hasMobileToken: false,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: false,
    site3: false,
  },
  {
    env: {
      maxTouchPoints: 0,
      platform: "Win32",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 OPR/109.0.0.0",
    },
    name: "Opera (OPR)",
    primitives: {
      hasChromeToken: true,
      hasIosDeviceToken: false,
      hasMobileToken: false,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: false,
    site3: false,
  },
  {
    env: {
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36",
    },
    name: "Samsung Internet (SamsungBrowser)",
    primitives: {
      hasChromeToken: true,
      hasIosDeviceToken: false,
      hasMobileToken: true,
      hasSafariToken: true,
      isAppleMobileWebKit: false,
      isAppleTouchDesktop: false,
      isSafariBrowser: false,
      isWebKitDesktopSafari: false,
    },
    site1: false,
    site2: false,
    site3: false,
  },
];

describe("webkit-runtime shared primitives", () => {
  it.each(CASES)("pins primitive predicates for $name", ({ env, primitives }) => {
    expect({
      hasChromeToken: hasChromeToken(env),
      hasIosDeviceToken: hasIosDeviceToken(env),
      hasMobileToken: hasMobileToken(env),
      hasSafariToken: hasSafariToken(env),
      isAppleMobileWebKit: isAppleMobileWebKit(env),
      isAppleTouchDesktop: isAppleTouchDesktop(env),
      isSafariBrowser: isSafariBrowser(env),
      isWebKitDesktopSafari: isWebKitDesktopSafari(env),
    }).toEqual(primitives);
  });

  it("treats an empty environment as a non-Safari, non-WebKit runtime", () => {
    const env: WebKitRuntimeEnvironment = {};
    expect(hasSafariToken(env)).toBe(false);
    expect(hasChromeToken(env)).toBe(false);
    expect(hasIosDeviceToken(env)).toBe(false);
    expect(hasMobileToken(env)).toBe(false);
    expect(isAppleTouchDesktop(env)).toBe(false);
    expect(isSafariBrowser(env)).toBe(false);
    expect(isWebKitDesktopSafari(env)).toBe(false);
    expect(isAppleMobileWebKit(env)).toBe(false);
  });
});

describe("webkit-runtime composed call-site predicates", () => {
  it.each(CASES)("site 1 (isMobileSafariLike) matches the original for $name", ({ env, site1 }) => {
    expect(composedSite1(env)).toBe(site1);
    expect(composedSite1(env)).toBe(originalIsMobileSafariLike(env.userAgent, env.platform, env.maxTouchPoints));
  });

  it.each(CASES)("site 2 (isMobileSafari) matches the original for $name", ({ env, site2 }) => {
    expect(composedSite2(env)).toBe(site2);
    expect(composedSite2(env)).toBe(originalIsMobileSafari(env.userAgent, env.platform, env.maxTouchPoints));
  });

  it.each(CASES)("site 3 (isWebKitInputRuntime) matches the original for $name", ({ env, site3 }) => {
    expect(composedSite3(env)).toBe(site3);
    expect(composedSite3(env)).toBe(originalIsWebKitInputRuntime(env.userAgent, env.platform, env.maxTouchPoints));
  });

  // iPadOS desktop-mode (MacIntel + touch) with an empty UA: site 3's early
  // return must keep it non-WebKit even though isAppleTouchDesktop would be true.
  it("site 3 keeps an empty UA non-WebKit even on a touch MacIntel surface", () => {
    const env: WebKitRuntimeEnvironment = { maxTouchPoints: 5, platform: "MacIntel", userAgent: "" };
    expect(composedSite3(env)).toBe(false);
    expect(composedSite3(env)).toBe(originalIsWebKitInputRuntime("", "MacIntel", 5));
  });
});

describe("getFileInputAcceptAttributes composes site 2 end to end", () => {
  it.each(CASES)("returns the MIME fallback only when site 2 is true for $name", ({ env, site2 }) => {
    const attributes = getFileInputAcceptAttributes(env);
    const usesMimeFallback = attributes.unifiedRom.includes("application/octet-stream");
    expect(usesMimeFallback).toBe(site2);
    // unifiedRom and unifiedApply move together: both fall back, or neither does.
    expect(attributes.unifiedApply.includes("application/octet-stream")).toBe(site2);
  });
});
