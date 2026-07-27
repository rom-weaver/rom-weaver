const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Minimal STORE-only zip writer. Keeping the fixture generated makes entry count a free parameter
 * for both the browser-WASM resource test and the real dev-server E2E regression.
 */
export function buildStoredZip(entryCount, entrySize) {
  const encoder = new TextEncoder();
  const payload = new Uint8Array(entrySize);
  for (let index = 0; index < entrySize; index += 1) payload[index] = index & 0xff;
  const payloadCrc = crc32(payload);

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const name = encoder.encode(`entry-${String(index).padStart(5, "0")}.bin`);
    const local = new Uint8Array(30 + name.byteLength + entrySize);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, payloadCrc, true);
    localView.setUint32(18, entrySize, true);
    localView.setUint32(22, entrySize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(payload, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, payloadCrc, true);
    centralView.setUint32(20, entrySize, true);
    centralView.setUint32(24, entrySize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entryCount, true);
  endView.setUint16(10, entryCount, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const zip = new Uint8Array(offset + centralSize + end.byteLength);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    zip.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return zip;
}
