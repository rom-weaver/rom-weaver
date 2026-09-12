// Sidecars need the original asset's content type, not the .br file's type.
// writeBrotliSidecars MUST reject extensions absent from this table.
// JavaScript uses text/javascript: https://www.rfc-editor.org/rfc/rfc9239
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
