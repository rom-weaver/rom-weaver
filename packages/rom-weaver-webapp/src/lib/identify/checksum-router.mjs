/**
 * RWCR1 checksum router: one binary fuse filter per identify pack, so a bare
 * crc32/md5/sha1 can name the packs that may hold it without loading them.
 *
 * The router stores fingerprints only, never a checksum. A query answers
 * "maybe in this pack" or "definitely not"; the pack itself gives the final
 * answer. A key present in a pack is always reported for that pack. Packs that
 * do not hold the key answer "maybe" at roughly 1/256 each.
 *
 * Shared by the data builder (`scripts/build-identify-index.mjs`) and the
 * browser (`platform/browser/identify-packs.ts`). It MUST stay free of Node
 * and DOM APIs.
 *
 * Filter construction follows the 3-wise binary fuse filter reference
 * (https://github.com/FastFilter/xor_singleheader, "Binary Fuse Filters: Fast
 * and Smaller Than Xor Filters", https://doi.org/10.1145/3510449) with 8-bit
 * fingerprints. Seeds are drawn from a fixed sequence so a rebuild over the
 * same keys is byte-identical.
 *
 * Layout, little-endian:
 *   magic "RWCR1\0\0\0"
 *   u32 packCount
 *   per pack:
 *     u16 slugLength, slug (UTF-8)
 *     u32 keyCount
 *     u64 seed
 *     u32 segmentLength
 *     u32 segmentCountLength
 *     u32 arrayLength
 *     u8[arrayLength] fingerprints
 */

const MAGIC = new Uint8Array([0x52, 0x57, 0x43, 0x52, 0x31, 0, 0, 0]);
const CHECKSUM_ROUTER_FORMAT = "rom-weaver-identify-checksum-router-v1";
const MAX_PACKS = 4096;
const MAX_SLUG_BYTES = 256;
const MAX_ARRAY_LENGTH = 1 << 28;
const ARITY = 3;
const MAX_CONSTRUCTION_ATTEMPTS = 100;
const U64 = (1n << 64n) - 1n;

/** Hex length -> algorithm tag. The tag is mixed into the key so a crc32 never routes as an md5 prefix. */
const ALGORITHM_BY_HEX_LENGTH = Object.freeze({ 8: "crc32", 32: "md5", 40: "sha1" });
const TAG_BY_ALGORITHM = Object.freeze({ crc32: 1n, md5: 2n, sha1: 3n });

/**
 * @typedef {"crc32" | "md5" | "sha1"} RouterAlgorithm
 * @typedef {{ algorithm: RouterAlgorithm; hex: string }} RouterKey
 * @typedef {{
 *   slug: string;
 *   keyCount: number;
 *   seed: bigint;
 *   segmentLength: number;
 *   segmentCountLength: number;
 *   fingerprints: Uint8Array;
 * }} PackFilter
 * @typedef {{ packs: PackFilter[] }} ChecksumRouter
 */

/** @param {string} hex */
const algorithmForHex = (hex) => {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/u.test(normalized)) return undefined;
  const algorithm = ALGORITHM_BY_HEX_LENGTH[/** @type {8 | 32 | 40} */ (normalized.length)];
  return algorithm ? { algorithm, hex: normalized } : undefined;
};

/**
 * A key's 64-bit identity: the algorithm tag in the top byte, then the first
 * seven digest bytes. A crc32 fills only four of those; the rest stay zero.
 * @param {RouterKey} key
 */
const keyIdentity = ({ algorithm, hex }) => {
  const tag = TAG_BY_ALGORITHM[algorithm];
  if (tag === undefined) throw new Error(`checksum router: unsupported algorithm ${algorithm}`);
  const prefix = hex.slice(0, 14).padEnd(14, "0");
  return (tag << 56n) | BigInt(`0x${prefix}`);
};

/** MurmurHash3 64-bit finaliser. @param {bigint} h */
const murmur64 = (h) => {
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & U64;
  h ^= h >> 33n;
  h = (h * 0xc4ceb9fe1a85ec53n) & U64;
  h ^= h >> 33n;
  return h;
};

/** @param {bigint} key @param {bigint} seed */
const mixSplit = (key, seed) => murmur64((key + seed) & U64);

/** @param {bigint} hash */
const fingerprintOf = (hash) => Number((hash ^ (hash >> 32n)) & 0xffn);

/**
 * The three slots a hash touches, per the reference `binary_fuse8_hash_batch`.
 * @param {bigint} hash @param {number} segmentLength @param {number} segmentCountLength
 */
const hashBatch = (hash, segmentLength, segmentCountLength) => {
  const mask = BigInt(segmentLength - 1);
  const h0 = Number((hash * BigInt(segmentCountLength)) >> 64n);
  let h1 = h0 + segmentLength;
  let h2 = h1 + segmentLength;
  h1 ^= Number((hash >> 18n) & mask);
  h2 ^= Number(hash & mask);
  return /** @type {[number, number, number]} */ ([h0, h1, h2]);
};

/**
 * Slot at `position` in the cyclic order h0, h1, h2, h0, h1 the peeling walk
 * uses; `position` is 0..4.
 * @param {[number, number, number]} slots @param {number} position
 */
const slotAt = (slots, position) => slots[position % 3] ?? 0;

/** Fixed seed sequence (splitmix64) so rebuilds are reproducible. @param {number} attempt */
const seedForAttempt = (attempt) => {
  let z = (0x9e3779b97f4a7c15n * BigInt(attempt + 1) + 0x243f6a8885a308d3n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return z ^ (z >> 31n);
};

/** @param {number} n */
const filterGeometry = (n) => {
  let segmentLength = n === 0 ? 4 : 1 << Math.floor(Math.log(n) / Math.log(3.33) + 2.25);
  if (segmentLength > 262144) segmentLength = 262144;
  const sizeFactor = n <= 1 ? 1.125 : Math.max(1.125, 0.875 + (0.25 * Math.log(1_000_000)) / Math.log(n));
  const capacity = n <= 1 ? 0 : Math.round(n * sizeFactor);
  let segmentCount = Math.floor((capacity + segmentLength - 1) / segmentLength) - (ARITY - 1);
  let arrayLength = (segmentCount + ARITY - 1) * segmentLength;
  if (arrayLength < 4 * segmentLength) {
    // Tiny inputs: keep at least one full segment window so every slot exists.
    segmentCount = 1;
    arrayLength = (segmentCount + ARITY - 1) * segmentLength;
  }
  return { segmentLength, segmentCount, segmentCountLength: segmentCount * segmentLength, arrayLength };
};

/** @param {number} x */
const mod3 = (x) => (x > 2 ? x - 3 : x);

/** Typed-array reads inside the construction are always in bounds; the fallback only satisfies the type checker. */
/** @param {Uint8Array | Uint32Array} array @param {number} index */
const at = (array, index) => array[index] ?? 0;
/** @param {BigUint64Array} array @param {number} index */
const bigAt = (array, index) => array[index] ?? 0n;

/**
 * Build one pack's filter over its keys. Duplicate keys are collapsed first;
 * the reference construction cannot peel duplicates.
 * @param {string} slug
 * @param {Iterable<RouterKey>} keys
 * @returns {PackFilter}
 */
const buildPackFilter = (slug, keys) => {
  const identities = [...new Set([...keys].map(keyIdentity))];
  const size = identities.length;
  const { segmentLength, segmentCount, segmentCountLength, arrayLength } = filterGeometry(size);
  const fingerprints = new Uint8Array(arrayLength);
  if (size === 0) {
    return { slug, keyCount: 0, seed: seedForAttempt(0), segmentLength, segmentCountLength, fingerprints };
  }
  const reverseOrder = new BigUint64Array(size + 1);
  const reverseH = new Uint8Array(size);
  const alone = new Uint32Array(arrayLength);
  const t2count = new Uint8Array(arrayLength);
  const t2hash = new BigUint64Array(arrayLength);
  let blockBits = 1;
  while (1 << blockBits < segmentCount) blockBits += 1;
  const block = 1 << blockBits;
  const startPos = new Uint32Array(block);

  for (let attempt = 0; attempt < MAX_CONSTRUCTION_ATTEMPTS; attempt += 1) {
    const seed = seedForAttempt(attempt);
    reverseOrder.fill(0n);
    reverseOrder[size] = 1n;
    t2count.fill(0);
    t2hash.fill(0n);
    for (let i = 0; i < block; i += 1) startPos[i] = Number((BigInt(i) * BigInt(size)) >> BigInt(blockBits));
    const maskBlock = block - 1;
    for (const identity of identities) {
      const hash = mixSplit(identity, seed);
      let segmentIndex = Number(hash >> BigInt(64 - blockBits));
      while (bigAt(reverseOrder, at(startPos, segmentIndex)) !== 0n) segmentIndex = (segmentIndex + 1) & maskBlock;
      reverseOrder[at(startPos, segmentIndex)] = hash;
      startPos[segmentIndex] = at(startPos, segmentIndex) + 1;
    }
    let error = false;
    for (let i = 0; i < size; i += 1) {
      const hash = bigAt(reverseOrder, i);
      const [h0, h1, h2] = hashBatch(hash, segmentLength, segmentCountLength);
      t2count[h0] = at(t2count, h0) + 4;
      t2hash[h0] = bigAt(t2hash, h0) ^ hash;
      t2count[h1] = (at(t2count, h1) + 4) ^ 1;
      t2hash[h1] = bigAt(t2hash, h1) ^ hash;
      t2count[h2] = (at(t2count, h2) + 4) ^ 2;
      t2hash[h2] = bigAt(t2hash, h2) ^ hash;
      if (at(t2count, h0) < 4 || at(t2count, h1) < 4 || at(t2count, h2) < 4) error = true;
    }
    if (error) continue;
    let queueSize = 0;
    for (let i = 0; i < arrayLength; i += 1) {
      alone[queueSize] = i;
      queueSize += at(t2count, i) >> 2 === 1 ? 1 : 0;
    }
    let stackSize = 0;
    while (queueSize > 0) {
      queueSize -= 1;
      const index = at(alone, queueSize);
      if (at(t2count, index) >> 2 !== 1) continue;
      const hash = bigAt(t2hash, index);
      const found = at(t2count, index) & 3;
      reverseH[stackSize] = found;
      reverseOrder[stackSize] = hash;
      stackSize += 1;
      const slots = hashBatch(hash, segmentLength, segmentCountLength);
      for (const step of [1, 2]) {
        const other = slotAt(slots, found + step);
        alone[queueSize] = other;
        queueSize += at(t2count, other) >> 2 === 2 ? 1 : 0;
        t2count[other] = (at(t2count, other) - 4) ^ mod3(found + step);
        t2hash[other] = bigAt(t2hash, other) ^ hash;
      }
    }
    if (stackSize !== size) continue;
    for (let i = size - 1; i >= 0; i -= 1) {
      const hash = bigAt(reverseOrder, i);
      const found = at(reverseH, i);
      const slots = hashBatch(hash, segmentLength, segmentCountLength);
      fingerprints[slotAt(slots, found)] =
        fingerprintOf(hash) ^ at(fingerprints, slotAt(slots, found + 1)) ^ at(fingerprints, slotAt(slots, found + 2));
    }
    return { slug, keyCount: size, seed, segmentLength, segmentCountLength, fingerprints };
  }
  throw new Error(`checksum router: could not build a filter for ${slug} after ${MAX_CONSTRUCTION_ATTEMPTS} attempts`);
};

/** @param {PackFilter} filter @param {bigint} identity */
const filterMayContain = (filter, identity) => {
  if (filter.keyCount === 0) return false;
  const hash = mixSplit(identity, filter.seed);
  const [h0, h1, h2] = hashBatch(hash, filter.segmentLength, filter.segmentCountLength);
  const { fingerprints } = filter;
  return fingerprintOf(hash) === (at(fingerprints, h0) ^ at(fingerprints, h1) ^ at(fingerprints, h2));
};

/**
 * Pack slugs that may hold any of the digests. Digests with an unknown hex
 * length are ignored. An empty result is a definitive miss.
 * @param {ChecksumRouter} router
 * @param {Iterable<string>} digests
 * @returns {string[]}
 */
const routeChecksums = (router, digests) => {
  const identities = [];
  for (const digest of digests) {
    const key = algorithmForHex(digest);
    if (key) identities.push(keyIdentity(key));
  }
  if (!identities.length) return [];
  const slugs = [];
  for (const filter of router.packs) {
    if (identities.some((identity) => filterMayContain(filter, identity))) slugs.push(filter.slug);
  }
  return slugs;
};

/** @param {PackFilter[]} packs @returns {Uint8Array} */
const encodeChecksumRouter = (packs) => {
  if (packs.length > MAX_PACKS) throw new Error(`checksum router: too many packs (${packs.length})`);
  const encoder = new TextEncoder();
  const parts = [];
  let total = MAGIC.length + 4;
  for (const pack of packs) {
    const slug = encoder.encode(pack.slug);
    if (slug.length === 0 || slug.length > MAX_SLUG_BYTES)
      throw new Error(`checksum router: invalid slug ${pack.slug}`);
    parts.push({ pack, slug });
    total += 2 + slug.length + 4 + 8 + 4 + 4 + 4 + pack.fingerprints.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  let offset = MAGIC.length;
  view.setUint32(offset, packs.length, true);
  offset += 4;
  for (const { pack, slug } of parts) {
    view.setUint16(offset, slug.length, true);
    offset += 2;
    out.set(slug, offset);
    offset += slug.length;
    view.setUint32(offset, pack.keyCount, true);
    offset += 4;
    view.setBigUint64(offset, pack.seed, true);
    offset += 8;
    view.setUint32(offset, pack.segmentLength, true);
    offset += 4;
    view.setUint32(offset, pack.segmentCountLength, true);
    offset += 4;
    view.setUint32(offset, pack.fingerprints.length, true);
    offset += 4;
    out.set(pack.fingerprints, offset);
    offset += pack.fingerprints.length;
  }
  return out;
};

/** @param {string} message */
const invalid = (message) => new Error(`checksum router is invalid: ${message}`);

/**
 * Parse RWCR1 bytes. Every bound is checked so a corrupt or truncated file
 * fails here instead of producing wrong routes.
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {ChecksumRouter}
 */
const parseChecksumRouter = (bytes) => {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < MAGIC.length + 4 || !MAGIC.every((byte, i) => data[i] === byte)) throw invalid("bad magic");
  let offset = MAGIC.length;
  const packCount = view.getUint32(offset, true);
  offset += 4;
  if (packCount > MAX_PACKS) throw invalid(`pack count ${packCount} is out of range`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  /** @type {PackFilter[]} */
  const packs = [];
  const seen = new Set();
  for (let i = 0; i < packCount; i += 1) {
    if (offset + 2 > data.length) throw invalid("truncated pack header");
    const slugLength = view.getUint16(offset, true);
    offset += 2;
    if (slugLength === 0 || slugLength > MAX_SLUG_BYTES || offset + slugLength + 24 > data.length) {
      throw invalid("truncated pack slug");
    }
    let slug;
    try {
      slug = decoder.decode(data.subarray(offset, offset + slugLength));
    } catch {
      throw invalid("pack slug is not UTF-8");
    }
    offset += slugLength;
    if (seen.has(slug)) throw invalid(`duplicate pack ${slug}`);
    seen.add(slug);
    const keyCount = view.getUint32(offset, true);
    offset += 4;
    const seed = view.getBigUint64(offset, true);
    offset += 8;
    const segmentLength = view.getUint32(offset, true);
    offset += 4;
    const segmentCountLength = view.getUint32(offset, true);
    offset += 4;
    const arrayLength = view.getUint32(offset, true);
    offset += 4;
    if (segmentLength === 0 || (segmentLength & (segmentLength - 1)) !== 0) throw invalid(`${slug}: segment length`);
    if (arrayLength > MAX_ARRAY_LENGTH || offset + arrayLength > data.length) throw invalid(`${slug}: truncated`);
    // Every slot index the batch can produce MUST exist: h0 < segmentCountLength, h2 < h0 + 3 * segmentLength.
    if (
      segmentCountLength % segmentLength !== 0 ||
      arrayLength % segmentLength !== 0 ||
      segmentCountLength + 2 * segmentLength > arrayLength
    ) {
      throw invalid(`${slug}: segment layout`);
    }
    if (keyCount > 0 && arrayLength === 0) throw invalid(`${slug}: empty filter with keys`);
    const fingerprints = data.slice(offset, offset + arrayLength);
    offset += arrayLength;
    packs.push({ slug, keyCount, seed, segmentLength, segmentCountLength, fingerprints });
  }
  if (offset !== data.length) throw invalid("trailing bytes");
  return { packs };
};

export {
  algorithmForHex,
  buildPackFilter,
  CHECKSUM_ROUTER_FORMAT,
  encodeChecksumRouter,
  parseChecksumRouter,
  routeChecksums,
};
