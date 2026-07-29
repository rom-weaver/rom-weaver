// Content types for the file extensions the build stages brotli sidecars for,
// matching what Pages itself serves for the same files. The function needs them
// because a sidecar response is built from the `.br` sibling, which carries no
// usable type of its own.
//
// This is the one place the mapping lives: writeBrotliSidecars imports it and
// fails the build if it stages a sidecar for an extension that is missing here,
// so a new sidecar-backed file type cannot ship without its type. Extend it in
// the same commit that widens the sidecar set.
export const SIDECAR_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
};

export const sidecarContentType = (pathname) => SIDECAR_CONTENT_TYPES[pathname.slice(pathname.lastIndexOf("."))];
