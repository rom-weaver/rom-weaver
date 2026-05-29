// In-memory stand-in for FileSystemSyncAccessHandle. The real handle is only constructible inside a
// dedicated Worker, so page-context tests/benches that want to exercise BrowserOpfsRandomAccessFile's
// read-cache and write logic in isolation use this mock instead. Semantics mirror the OPFS spec:
// read/write return byte counts, writing past the end extends the file, truncate grows with zeros.

export function createMockSyncAccessHandle({ size = 0, fill = null } = {}) {
  let bytes = new Uint8Array(size);
  if (typeof fill === 'function') {
    for (let index = 0; index < size; index += 1) bytes[index] = fill(index) & 0xff;
  }
  let closed = false;

  const ensureLogicalSize = (nextSize) => {
    if (nextSize <= bytes.length) return;
    const grown = new Uint8Array(nextSize);
    grown.set(bytes);
    bytes = grown;
  };

  return {
    read(buffer, { at = 0 } = {}) {
      if (closed) return 0;
      const start = Number(at);
      if (!Number.isFinite(start) || start < 0 || start >= bytes.length) return 0;
      const length = Math.min(buffer.byteLength, bytes.length - start);
      buffer.set(bytes.subarray(start, start + length));
      return length;
    },
    write(buffer, { at = 0 } = {}) {
      if (closed) return 0;
      const start = Number(at);
      ensureLogicalSize(start + buffer.byteLength);
      bytes.set(buffer, start);
      return buffer.byteLength;
    },
    getSize() {
      return bytes.length;
    },
    truncate(nextSize) {
      const size = Number(nextSize);
      if (size < bytes.length) {
        bytes = bytes.slice(0, size);
        return;
      }
      ensureLogicalSize(size);
    },
    flush() {},
    close() {
      closed = true;
    },
    // Test-only accessor for asserting the underlying bytes directly.
    __snapshot() {
      return bytes.slice();
    },
  };
}
