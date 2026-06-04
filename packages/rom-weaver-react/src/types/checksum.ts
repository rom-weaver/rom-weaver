type ChecksumResult = {
  adler32?: number;
  crc16?: number;
  crc32: number;
  md5: string;
  romProbe?: ChecksumRomProbe;
  sha1: string;
};

type ChecksumRomProbe = {
  trim: {
    detected: boolean;
    mode?: string;
    preservedDownloadPlayCert?: boolean;
    trimmedInputBytes?: number;
  };
};

export type { ChecksumResult, ChecksumRomProbe };
