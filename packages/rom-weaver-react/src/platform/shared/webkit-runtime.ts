/**
 * Single source of truth for the user-agent / platform tokens and primitive
 * predicates used to detect Safari and WebKit runtimes across the webapp.
 *
 * THREE call sites historically hand-rolled their own copy-pasted (and subtly
 * DIVERGENT) regexes:
 *
 *   1. `webapp/browser-runtime-diagnostics.ts` (`isMobileSafariLike`) — the
 *      mobile-Safari diagnostic flag.
 *   2. `public/react/file-input-accept.ts` (`isMobileSafari`) — whether to fall
 *      back to a MIME `accept` list because mobile Safari ignores
 *      extension-only `accept`.
 *   3. `workers/protocol/browser-opfs-source-ref.ts` (`isWebKitInputRuntime`) —
 *      load-bearing: picks the OPFS proxy-handle read path over the
 *      FileReaderSync fast path on WebKit.
 *
 * Their results intentionally differ (different Chromium-on-iOS exclusion sets,
 * different "is this a mobile/Apple device" notions), and those differences are
 * deliberate — site 3 must include desktop Safari, site 2 only treats CriOS/
 * FxiOS/EdgiOS as Safari, etc. The goal of this module is NOT to make the three
 * identical; it is to own the regex/token building blocks in ONE place so a
 * future UA fix is a single edit and the divergence between sites is visible
 * here. Each call site composes its EXACT current predicate from these
 * primitives.
 *
 * Every primitive takes an explicit environment snapshot so it is pure and
 * directly unit-testable; the call sites read the live `navigator` and pass it
 * in.
 */

type WebKitRuntimeEnvironment = {
  maxTouchPoints?: number;
  platform?: string;
  userAgent?: string;
};

// --- User-agent token regexes (the shared vocabulary) -----------------------

// Present in every WebKit UA, but also (as a sub-token) in Chrome/Edge/Opera on
// many platforms, so on its own it does NOT mean "Safari".
const SAFARI_TOKEN_REGEX = /Safari/;

// Chrome desktop/Android. Note `Chromium` contains `Chrome` as a substring, so
// `/Chrome/` already matches Chromium UAs too.
const CHROME_TOKEN_REGEX = /Chrome/;

// iOS device markers (iPhone / iPad / iPod). Pre-iPadOS-13 iPad UAs and iPhone/
// iPod UAs carry these; modern iPadOS desktop-mode UAs do NOT (they masquerade
// as macOS and are detected via the MacIntel + touch heuristic instead).
const IOS_DEVICE_TOKEN_REGEX = /iP(hone|ad|od)/;

// The trailing "Mobile/<build> " marker Safari (and other engines) add on phones
// and on iPad in mobile mode.
const MOBILE_TOKEN_REGEX = /Mobile(\/\S+)? /;

// Non-Safari engines that nonetheless carry the `Safari` sub-token. Each call
// site historically excluded a DIFFERENT subset of these; the subsets are named
// so the divergence is explicit.

// Site 1 (`isMobileSafariLike`): excludes Chrome/Chromium plus the iOS WebView
// apps that re-skin WebKit (CriOS = Chrome iOS, FxiOS = Firefox iOS,
// EdgiOS = Edge iOS).
const SAFARI_LIKE_NON_SAFARI_REGEX = /(Chrome|Chromium|CriOS|FxiOS|EdgiOS)/;

// Site 3 (`isWebKitInputRuntime` desktop branch): excludes Chrome/Chromium,
// Edge (`Edg`), Opera (`OPR`), and Samsung Internet. Deliberately does NOT list
// CriOS/FxiOS/EdgiOS — those iOS apps are caught by the Apple-mobile branch, so
// the desktop branch keeps treating bare-WebKit-ish desktop UAs as Safari.
const WEBKIT_DESKTOP_NON_SAFARI_REGEX = /(Chrome|Chromium|Edg|OPR|SamsungBrowser)/;

// --- Primitive predicates ---------------------------------------------------

const getUserAgent = (environment: WebKitRuntimeEnvironment) => environment.userAgent || "";
const getPlatform = (environment: WebKitRuntimeEnvironment) => environment.platform || "";
const getMaxTouchPoints = (environment: WebKitRuntimeEnvironment) =>
  typeof environment.maxTouchPoints === "number" ? environment.maxTouchPoints : 0;

/** UA carries the bare `Safari` token (true for Chrome/Edge/Opera too). */
const hasSafariToken = (environment: WebKitRuntimeEnvironment) => SAFARI_TOKEN_REGEX.test(getUserAgent(environment));

/** UA carries the `Chrome` token (also matches `Chromium`). */
const hasChromeToken = (environment: WebKitRuntimeEnvironment) => CHROME_TOKEN_REGEX.test(getUserAgent(environment));

/** UA carries an iPhone/iPad/iPod device marker. */
const hasIosDeviceToken = (environment: WebKitRuntimeEnvironment) =>
  IOS_DEVICE_TOKEN_REGEX.test(getUserAgent(environment));

/** UA carries the `Mobile/<build>` marker. */
const hasMobileToken = (environment: WebKitRuntimeEnvironment) => MOBILE_TOKEN_REGEX.test(getUserAgent(environment));

/**
 * Desktop-class macOS reporting touch input — i.e. iPadOS in desktop mode,
 * which masquerades as `MacIntel` but exposes `maxTouchPoints > 1`. Real Macs
 * report `maxTouchPoints === 0`.
 */
const isAppleTouchDesktop = (environment: WebKitRuntimeEnvironment) =>
  getPlatform(environment) === "MacIntel" && getMaxTouchPoints(environment) > 1;

/**
 * "Real Safari" per site 1's definition: the `Safari` token without any of the
 * Chrome/Chromium/CriOS/FxiOS/EdgiOS engines. Used by the mobile-Safari
 * diagnostic and the file-input accept fallback's mobile branch.
 */
const isSafariBrowser = (environment: WebKitRuntimeEnvironment) =>
  hasSafariToken(environment) && !SAFARI_LIKE_NON_SAFARI_REGEX.test(getUserAgent(environment));

/**
 * Site 3's desktop-Safari branch: the `Safari` token without
 * Chrome/Chromium/Edg/OPR/SamsungBrowser. Distinct from {@link isSafariBrowser}
 * (different exclusion set) by design — keep them separate so neither site's
 * classification shifts.
 */
const isWebKitDesktopSafari = (environment: WebKitRuntimeEnvironment) =>
  hasSafariToken(environment) && !WEBKIT_DESKTOP_NON_SAFARI_REGEX.test(getUserAgent(environment));

/**
 * Any Apple mobile WebKit runtime (every iOS/iPadOS browser shares the same
 * WebKit file layer): an iPhone/iPad/iPod UA, or iPadOS desktop mode detected
 * via {@link isAppleTouchDesktop}. Note this is engine-level, so it is true for
 * CriOS/FxiOS/EdgiOS as well.
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
