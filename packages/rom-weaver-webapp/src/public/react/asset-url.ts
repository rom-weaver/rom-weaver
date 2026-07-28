/**
 * Resolves a bare asset name (`first-weave.zip`) against the app's base URL.
 *
 * The webapp passes its own base, which has the route segment stripped, so the
 * result is correct from `/weave/` and from a sub-path deployment alike. A
 * root-absolute path would only work when the app is served from the domain
 * root, and a document-relative one resolves inside the current route.
 */
const resolveAssetUrl = (assetBaseUrl: string | undefined, name: string): string => {
  const base = assetBaseUrl?.trim();
  // No base configured: keep the historical root-absolute form. The webapp
  // always supplies one, so this only covers embedders, and a bugfix should
  // not move their asset paths underneath them.
  if (!base) return `/${name}`;
  try {
    return new URL(name, base).href;
  } catch {
    return `/${name}`;
  }
};

export { resolveAssetUrl };
