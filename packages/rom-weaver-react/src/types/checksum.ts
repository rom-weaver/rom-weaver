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
  sha1: string;
  variants?: ChecksumVariant[];
};

type ChecksumRomProbe = {
  trim: {
    detected: boolean;
    mode?: string;
    preservedDownloadPlayCert?: boolean;
    trimmedInputBytes?: number;
  };
};

export type { ChecksumMap, ChecksumResult, ChecksumRomProbe, ChecksumVariant };
