/**
 * The route below the app base: lowercase, without `index.html` or a trailing slash, and `""` for the base itself.
 * Returns `null` when the pathname is outside the base. A trailing `.html` is kept for the caller to judge.
 *
 * @param {string | undefined} pathname
 * @param {string} [basePath] Ends with `/`.
 * @returns {string | null}
 */
const readRoutePath = (pathname, basePath = "/") => {
  const path = String(pathname || "").trim();
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
