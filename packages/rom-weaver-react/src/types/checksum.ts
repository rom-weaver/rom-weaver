type ChecksumResult = {
  adler32?: number;
  crc16?: number;
  crc32: number;
  md5: string;
  sha1: string;
};

export type { ChecksumResult };
