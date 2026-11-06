// Not a string literal: Vite would rewrite `new URL("../", import.meta.url)` into an asset reference.
const ASSETS_PARENT = "../";

/**
 * The path the app is served under, ending in `/`. Every built chunk lives flat in `<base>/assets/`, so the
 * chunk's own URL names the base on any document type. Development and the server render have no such chunk.
 */
const APP_BASE_PATH: string =
  import.meta.env.DEV || typeof window === "undefined" ? "/" : new URL(ASSETS_PARENT, import.meta.url).pathname;

export { APP_BASE_PATH };
