/**
 * Snapshot of the browser/runtime environment, logged once at startup so
 * browser-specific bug reports (clipboard, OPFS, threading) carry the context
 * needed to reproduce - userAgent, secure-context/cross-origin-isolation
 * state, core count, touch/standalone hints, and async-clipboard availability.
 * Every field is guarded so it is safe under SSR and in tests.
 */

type BrowserInfo = {
  userAgent: string;
  vendor: string;
  platform: string;
  languages: string;
  hardwareConcurrency: number;
  maxTouchPoints: number;
  isSecureContext: boolean;
  crossOriginIsolated: boolean;
  standalone: boolean;
  origin: string;
  protocol: string;
  // "writeText": async Clipboard API usable; "present-no-writeText": clipboard
  // object exists but no writeText; "absent": no Clipboard API (the
  // non-secure-context case where copy falls back to execCommand).
  clipboardApi: "writeText" | "present-no-writeText" | "absent";
};

const matchesStandalone = (win: Window): boolean => {
  try {
    return !!win.matchMedia && win.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
};

const collectBrowserInfo = (): BrowserInfo => {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const win = typeof window === "undefined" ? undefined : window;
  const clipboard = nav?.clipboard;
  const hasWriteText = typeof clipboard?.writeText === "function";
  const clipboardApi = clipboard ? (hasWriteText ? "writeText" : "present-no-writeText") : "absent";
  const languages = nav?.languages?.length ? nav.languages.join(",") : (nav?.language ?? "");
  return {
    clipboardApi,
    crossOriginIsolated: !!win?.crossOriginIsolated,
    hardwareConcurrency: nav?.hardwareConcurrency ?? 0,
    isSecureContext: !!win?.isSecureContext,
    languages,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    origin: win?.location?.origin ?? "",
    platform: nav?.platform ?? "",
    protocol: win?.location?.protocol ?? "",
    standalone: win ? matchesStandalone(win) : false,
    userAgent: nav?.userAgent ?? "",
    vendor: nav?.vendor ?? "",
  };
};

export { collectBrowserInfo };
