// Content types for the file extensions the build stages brotli sidecars for,
// matching what Pages itself serves for the same files. The function needs them
// because a sidecar response is built from the `.br` sibling, which carries no
// usable type of its own.
//
// This is the one place the mapping lives: writeBrotliSidecars imports it and
// fails the build if it stages a sidecar for an extension that is missing here,
// so a new sidecar-backed file type cannot ship without its type. Extend it in
// the same commit that widens the sidecar set.
// These have to match what Pages serves on the static path: the same file is served by
// this function when the client accepts br and by Pages when it does not, and the two
// answering with different types is a difference with no cause. `text/javascript` is also
// the form RFC 9239 settles on - `application/javascript` is obsolete.
export const SIDECAR_CONTENT_TYPES = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".pack": "application/octet-stream",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

export const sidecarContentType = (pathname) => SIDECAR_CONTENT_TYPES[pathname.slice(pathname.lastIndexOf("."))];

// The identify manifests are the one mutable thing under `/assets/`: every pack,
// shard, and index they list is fetched with its content hash in the query, so
// the payloads are safe to freeze, but the manifest that carries those hashes
// MUST be revalidated or a deployment's new data stays invisible until the
// cached copy expires. Pages ignores `_headers` for any URL a Function claims,
// so these two paths get their Cache-Control here instead.
const MUTABLE_ASSET_PATHS = new Set(["/assets/identify-index.json", "/assets/identify-catalog.json"]);

export const isMutableAsset = (pathname) => MUTABLE_ASSET_PATHS.has(pathname);

export const assetCacheControl = (pathname) =>
  isMutableAsset(pathname) ? "no-cache" : "public, max-age=31536000, immutable";
