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
