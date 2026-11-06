// Not a string literal: Vite would rewrite `new URL("../", import.meta.url)` into an asset reference.
const ASSETS_PARENT = "../";

// A host that merges slashes serves `//apply-rom-patches`; a leading `//` would parse as a host, not a path.
const normalizeBasePath = (pathname: string): string => pathname.replace(/^\/{2,}/u, "/");

/** The path the app is served under, ending in `/`, read from this chunk's URL since every chunk sits flat in `<base>/assets/`. */
const APP_BASE_PATH: string =
  import.meta.env.DEV || typeof window === "undefined"
    ? "/"
    : normalizeBasePath(new URL(ASSETS_PARENT, import.meta.url).pathname);

export { APP_BASE_PATH, normalizeBasePath };
