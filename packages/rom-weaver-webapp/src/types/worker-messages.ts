type WorkerKind = "rom-weaver" | "storage";

type WorkerOutputRef = {
  fileName: string;
  filePath?: string;
  kind: "file" | "opfs";
  size?: number;
};

export type { WorkerKind, WorkerOutputRef };
