type BlobLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  name?: string;
  size: number;
  slice?: (start?: number, end?: number) => BlobLike;
  type?: string;
};

export type { BlobLike };
