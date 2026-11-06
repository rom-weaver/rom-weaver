/**
 * The lowercased route below `basePath` (`""` for the base itself, `null` outside it), keeping any `.html` suffix.
 *
 * @param {string | undefined} pathname
 * @param {string} [basePath] Ends with `/`.
 * @returns {string | null}
 */
const readRoutePath = (pathname, basePath = "/") => {
  // A host that merges slashes serves `//rom-weaver/` as `/rom-weaver/`.
  const path = String(pathname || "")
    .trim()
    .replace(/^\/{2,}/u, "/");
  if (path === basePath.slice(0, -1)) return "";
  if (!path.startsWith(basePath)) return null;
  const segments = path.slice(basePath.length).toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  return segments.join("/");
};

/**
 * Like [readRoutePath], without the `.html` suffix a static host may add.
 *
 * @param {string | undefined} pathname
 * @param {string} [basePath]
 */
const readExtensionlessRoutePath = (pathname, basePath = "/") =>
  readRoutePath(pathname, basePath)?.replace(/\.html$/u, "") ?? null;

export { readExtensionlessRoutePath, readRoutePath };
