type ChecksumMap = Record<string, string>;

type ChecksumVariant = {
  id: string;
  label: string;
  checksums: ChecksumMap;
  applyCompatibility?: {
    addHeader?: boolean;
    fixChecksum?: boolean;
    n64ByteOrder?: string;
    n64_byte_order?: string;
    removeHeader?: boolean;
    repair_checksum?: boolean;
    strip_header?: boolean;
  };
  transforms?: Record<string, unknown>;
};

type ChecksumResult = {
  adler32?: number;
  crc16?: number;
  crc32: number;
  md5: string;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
  sha1: string;
  variants?: ChecksumVariant[];
};

/** Backend-derived ROM platform/disc-format tag (e.g. "Sony PlayStation" + "CD").
 * Both fields are optional; renders next to the file size on workflow cards. */
type RomTypeTag = {
  platform?: string;
  discFormat?: string;
};

type ChecksumRomProbe = {
  trim: {
    detected: boolean;
    mode?: string;
    preservedDownloadPlayCert?: boolean;
    trimmedInputBytes?: number;
  };
};

/** Per-file extract wall-time split (ms), from the Rust `emitted_files[].timing` report detail.
 * `decodeMs` is the extract decode, `checksumMs` the hashing cost, `overlapMs` how much of the
 * checksum ran concurrently with decode. Surfaced on the workflow cards. */
type ExtractTiming = {
  totalMs?: number;
  decodeMs?: number;
  opfsWriteMs?: number;
  checksumMs?: number;
  overlapMs?: number;
  threaded?: boolean;
  workers?: number;
};

export type { ChecksumMap, ChecksumResult, ChecksumRomProbe, ChecksumVariant, ExtractTiming, RomTypeTag };
