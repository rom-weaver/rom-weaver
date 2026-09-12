/**
 * Shared Safari/WebKit user-agent tokens and primitive predicates.
 *
 * Callers intentionally compose different predicates: diagnostics, file-input
 * compatibility, and the OPFS read strategy do not share the same Safari
 * boundary. Explicit environment snapshots keep those predicates pure and
 * testable while centralizing the fragile token matching.
 */

type WebKitRuntimeEnvironment = {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
};

// --- User-agent token regexes (the shared vocabulary) -----------------------

// Also appears in Chrome/Edge/Opera UAs; insufficient alone to identify Safari.
const SAFARI_TOKEN_REGEX = /Safari/;

// Matches the Chrome token only; Chromium is listed separately in the exclusion sets below.
const CHROME_TOKEN_REGEX = /Chrome/;

// Modern desktop-mode iPadOS omits these and needs the MacIntel+touch heuristic.
const IOS_DEVICE_TOKEN_REGEX = /iP(hone|ad|od)/;

// Mobile-mode Safari and other engines carry this trailing marker.
const MOBILE_TOKEN_REGEX = /Mobile(\/\S+)? /;

// Named exclusion sets preserve intentional differences between callers.

// Diagnostics exclude Chrome/Chromium and branded iOS WebKit browsers.
const SAFARI_LIKE_NON_SAFARI_REGEX = /(Chrome|Chromium|CriOS|FxiOS|EdgiOS)/;

// The OPFS desktop branch excludes non-Safari desktop engines; branded iOS
// browsers are already caught by its Apple-mobile branch.
const WEBKIT_DESKTOP_NON_SAFARI_REGEX = /(Chrome|Chromium|Edg|OPR|SamsungBrowser)/;

// --- Primitive predicates ---------------------------------------------------

const getUserAgent = (environment: WebKitRuntimeEnvironment) => environment.userAgent || "";
const getPlatform = (environment: WebKitRuntimeEnvironment) => environment.platform || "";
const getMaxTouchPoints = (environment: WebKitRuntimeEnvironment) =>
  typeof environment.maxTouchPoints === "number" ? environment.maxTouchPoints : 0;

/** UA carries the bare `Safari` token (true for Chrome/Edge/Opera too). */
const hasSafariToken = (environment: WebKitRuntimeEnvironment) => SAFARI_TOKEN_REGEX.test(getUserAgent(environment));

/**
 * UA contains the Chrome token; a Chromium-only token does not match.
 */
const hasChromeToken = (environment: WebKitRuntimeEnvironment) => CHROME_TOKEN_REGEX.test(getUserAgent(environment));

/** UA carries an iPhone/iPad/iPod device marker. */
const hasIosDeviceToken = (environment: WebKitRuntimeEnvironment) =>
  IOS_DEVICE_TOKEN_REGEX.test(getUserAgent(environment));

/** UA carries the `Mobile/<build>` marker. */
const hasMobileToken = (environment: WebKitRuntimeEnvironment) => MOBILE_TOKEN_REGEX.test(getUserAgent(environment));

/**
 * Desktop-class macOS reporting touch input - i.e. iPadOS in desktop mode,
 * which masquerades as `MacIntel` but exposes `maxTouchPoints > 1`. Real Macs
 * report `maxTouchPoints === 0`.
 */
const isAppleTouchDesktop = (environment: WebKitRuntimeEnvironment) =>
  getPlatform(environment) === "MacIntel" && getMaxTouchPoints(environment) > 1;

/**
 * Safari heuristic used by mobile diagnostics and the file-input fallback.
 * The exclusion set also filters branded iOS browsers.
 */
const isSafariBrowser = (environment: WebKitRuntimeEnvironment) =>
  hasSafariToken(environment) && !SAFARI_LIKE_NON_SAFARI_REGEX.test(getUserAgent(environment));

/**
 * Desktop Safari heuristic used by the OPFS input strategy.
 * Its exclusion set differs from the diagnostic predicate.
 */
const isWebKitDesktopSafari = (environment: WebKitRuntimeEnvironment) =>
  hasSafariToken(environment) && !WEBKIT_DESKTOP_NON_SAFARI_REGEX.test(getUserAgent(environment));

/**
 * Apple-mobile heuristic based on device tokens or desktop-mode iPad detection.
 * It includes branded iOS user agents such as CriOS, FxiOS, and EdgiOS.
 */
const isAppleMobileWebKit = (environment: WebKitRuntimeEnvironment) =>
  hasIosDeviceToken(environment) || isAppleTouchDesktop(environment);

export {
  hasChromeToken,
  hasIosDeviceToken,
  hasMobileToken,
  hasSafariToken,
  isAppleMobileWebKit,
  isAppleTouchDesktop,
  isSafariBrowser,
  isWebKitDesktopSafari,
  type WebKitRuntimeEnvironment,
};
