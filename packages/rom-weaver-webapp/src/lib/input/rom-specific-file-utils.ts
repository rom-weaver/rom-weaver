import type { SourceMetadata } from "../../types/workflow-source.ts";
import { parseCueFile, replaceCuePatchFileName } from "../../workers/protocol/cue-file-utils.ts";

// Header checks MUST match crates/rom-weaver-containers/src/chd/infer.rs before CD inference;
// both run the cases in crates/rom-weaver-containers/tests/fixtures/chd-hard-disk-headers.json.
const hasChdHardDiskHeader = (bytes: Uint8Array, size: number): boolean => {
  if (size < 512 || size % 512 !== 0 || bytes.length < 512) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (offset: number) => view.getUint8(offset);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const u64 = (offset: number) => view.getBigUint64(offset, true);
  const logicalBytes = BigInt(size);
  const totalSectors = logicalBytes / 512n;
  const matches = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };
  const powerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;
  const volumeSize = (sectorBytes: number, sectors: bigint) =>
    [512, 1024, 2048, 4096].includes(sectorBytes) && sectors > 0n && sectors * BigInt(sectorBytes) <= logicalBytes;
  if (bytes[510] === 0x55 && bytes[511] === 0xaa) {
    let populated = 0;
    let validMbr = true;
    for (let offset = 446; offset < 510; offset += 16) {
      const type = bytes[offset + 4];
      const start = BigInt(u32(offset + 8));
      const count = BigInt(u32(offset + 12));
      if (type === 0 && start === 0n && count === 0n) continue;
      if (
        (bytes[offset] !== 0 && bytes[offset] !== 0x80) ||
        type === 0 ||
        start === 0n ||
        count === 0n ||
        start >= totalSectors ||
        (type !== 0xee && start + count > totalSectors)
      )
        validMbr = false;
      populated += 1;
    }
    if (validMbr && populated > 0) return true;
    const sectorBytes = u16(11);
    const clusterSectors = u8(13);
    if (
      powerOfTwo(clusterSectors) &&
      clusterSectors <= 128 &&
      u16(14) > 0 &&
      (bytes[16] === 1 || bytes[16] === 2) &&
      (u16(22) > 0 || u32(36) > 0) &&
      volumeSize(sectorBytes, BigInt(u16(19) || u32(32)))
    )
      return true;
    if (matches(3, "NTFS    ") && powerOfTwo(clusterSectors) && u64(48) > 0n && volumeSize(sectorBytes, u64(40)))
      return true;
    if (
      matches(3, "EXFAT   ") &&
      bytes.subarray(11, 64).every((byte) => byte === 0) &&
      u8(108) >= 9 &&
      u8(108) <= 12 &&
      u8(109) <= 25 &&
      volumeSize(2 ** u8(108), u64(72)) &&
      u32(80) > 0 &&
      u32(84) > 0 &&
      BigInt(u32(80)) + BigInt(u32(84)) <= u64(72) &&
      BigInt(u32(88)) < u64(72) &&
      u32(92) > 0
    )
      return true;
  }
  if (bytes.length < 1024 || !matches(512, "EFI PART")) return false;
  return (
    u32(524) >= 92 &&
    u32(524) <= 512 &&
    u64(536) === 1n &&
    u64(544) < totalSectors &&
    u64(552) <= u64(560) &&
    u64(560) < totalSectors &&
    u64(584) < totalSectors &&
    u32(592) > 0 &&
    u32(596) >= 128 &&
    u32(596) % 8 === 0
  );
};

const BIN_EXTENSION_REGEX = /\.bin$/i;

// Map the engine's `disc_format` verdict (Rust `rom_identity::DiscFormat::label()`
// - "CD"/"GD-ROM"/"DVD") to the optical-media label the CHD output panel shows.
// The verdict is computed once by the Rust ingest/checksum identity pass from
// disc signatures (not a TS filename/cue regex), so the UI mirrors exactly the
// media the CHD create produces. Returns `null` for a non-disc/unknown source.
const DISC_FORMAT_LABELS: Record<string, string> = {
  cd: "CD-ROM",
  dvd: "DVD",
  "gd-rom": "GD-ROM",
};

/** Display label for the engine-derived `disc_format` (e.g. "GD-ROM" → "GD-ROM"), or `null`. */
const getDiscFormatLabel = (discFormat: string | null | undefined): string | null => {
  const normalized = String(discFormat || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return DISC_FORMAT_LABELS[normalized] ?? null;
};

type ChdCodecMode = "cd" | "dvd";

/** Map the engine's `disc_format` verdict ("CD"/"GD-ROM"/"DVD") to the CHD create/recompress mode, or
 * `undefined` when the source is not a recognized optical medium. */
const discFormatToChdMode = (discFormat: string | null | undefined): ChdCodecMode | undefined => {
  const lower = String(discFormat || "").toLowerCase();
  if (lower === "dvd") return "dvd";
  if (lower === "cd" || lower.includes("gd")) return "cd";
  return undefined;
};

/** Coarse CHD codec mode for a source's metadata: the pre-identity `mode` if it is a CHD mode
 * ("cd"/"dvd"), else the Rust identity verdict (`format`). A non-CHD `mode` (e.g. rvz "iso"/"rvz")
 * is ignored so it can't be misread as a CHD mode. Never consults the display label. */
const chdModeFromMetadata = (metadata: SourceMetadata | null | undefined): ChdCodecMode | undefined => {
  const mode = metadata?.mode;
  if (mode === "cd" || mode === "dvd") return mode;
  return discFormatToChdMode(metadata?.format);
};

type ByteProbeableSource = {
  _u8array?: Uint8Array;
  _browserFileBacked?: boolean;
  fileName?: string;
  fileSize?: number;
  size?: number;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const matchesSourceBytes = (source: ByteProbeableSource, offset: number, expected: readonly number[]): boolean => {
  if (source._u8array) return expected.every((byte, index) => source._u8array?.[offset + index] === byte);
  if (source._browserFileBacked || !source.readIntoAt) return false;
  const bytes = new Uint8Array(expected.length);
  try {
    source.readIntoAt(bytes, 0, bytes.length, offset);
    return expected.every((byte, index) => bytes[index] === byte);
  } catch {
    return false;
  }
};

const CD_MAX_COOKED_BYTES = 450_000 * 2048;
/** Bytes covering raw CD descriptors and the UDF recognition sequence (LBA 16-31). */
const CHD_MEDIA_PROBE_BYTES = 32 * 2048;
const UDF_NSR_IDS = [
  [78, 83, 82, 48, 50],
  [78, 83, 82, 48, 51],
];

// Mirrors native `has_udf_descriptor`: a type-0 `NSR02`/`NSR03` descriptor in LBA 16-31.
const hasUdfDescriptor = (source: ByteProbeableSource, size: number | undefined): boolean => {
  if (typeof size !== "number" || size <= 0 || size % 2048 !== 0) return false;
  for (let sector = 16; sector < 32 && (sector + 1) * 2048 <= size; sector += 1) {
    const offset = sector * 2048;
    if (UDF_NSR_IDS.some((id) => matchesSourceBytes(source, offset, [0, ...id]))) return true;
  }
  return false;
};

const getChdStructuralMode = (source: { fileName?: string; metadata?: SourceMetadata }): ChdCodecMode | undefined => {
  const metadata = source.metadata;
  if (metadata?.mode === "cd" || metadata?.mode === "dvd") return metadata.mode;
  if (
    metadata?.cuePath ||
    metadata?.cueText ||
    metadata?.gdiText ||
    /\.(cue|gdi)$/i.test(source.fileName || "") ||
    /\.(cue|gdi)$/i.test(metadata?.sourceFileName || "")
  )
    return "cd";
  return undefined;
};

const isLooseChdAutoSource = (source: { fileName?: string; metadata?: SourceMetadata }): boolean =>
  !getChdStructuralMode(source) &&
  (BIN_EXTENSION_REGEX.test(source.fileName || "") || !/\.[^./\\]+$/.test(source.fileName || ""));

const getChdAutoCreateMode = (source: ByteProbeableSource & { metadata?: SourceMetadata }): string => {
  const structuralMode = getChdStructuralMode(source);
  if (structuralMode) return structuralMode;
  const mode = chdModeFromMetadata(source.metadata);
  if (mode && !isLooseChdAutoSource(source)) return mode;
  const fileName = String(source.fileName || "");
  const size = source.fileSize ?? source.size;
  const sectorSized = typeof size === "number" && size > 0 && (size % 2048 === 0 || size % 2352 === 0);
  if (/\.iso$/i.test(fileName))
    return sectorSized && size <= CD_MAX_COOKED_BYTES && !hasUdfDescriptor(source, size) ? "cd" : "dvd";
  // Ambiguous inputs MUST carry the same CD signatures used by the native CHD inference.
  if (typeof size === "number" && size > 0 && isLooseChdAutoSource(source)) {
    let header = source._u8array;
    if (!(header || source._browserFileBacked) && source.readIntoAt) {
      header = new Uint8Array(Math.min(size, 1024));
      try {
        source.readIntoAt(header, 0, header.length, 0);
      } catch {
        header = undefined;
      }
    }
    if (header && hasChdHardDiskHeader(header, size)) return "raw";
    const isoId = [67, 68, 48, 48, 49];
    if (
      size % 2352 === 0 &&
      (matchesSourceBytes(source, 0, [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]) ||
        matchesSourceBytes(source, 16 * 2352 + 17, isoId))
    )
      return "cd";
    if (size % 2048 === 0) {
      const cooked = matchesSourceBytes(source, 16 * 2048 + 1, isoId);
      const udf = hasUdfDescriptor(source, size);
      if (udf || (cooked && size > CD_MAX_COOKED_BYTES)) return "dvd";
      if (cooked) return "cd";
    }
    // Readable bytes decide, as native `auto` does; advisory identity applies only when unreadable.
    if (header) return "raw";
  }
  return mode || "raw";
};

export {
  CHD_MEDIA_PROBE_BYTES,
  chdModeFromMetadata,
  discFormatToChdMode,
  getChdAutoCreateMode,
  getDiscFormatLabel,
  hasChdHardDiskHeader,
  isLooseChdAutoSource,
  parseCueFile,
  replaceCuePatchFileName,
};
