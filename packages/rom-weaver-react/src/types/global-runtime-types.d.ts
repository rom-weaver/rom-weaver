declare global {
  type RuntimeValue = Parameters<Window["postMessage"]>[0];
  type RuntimeRecord = {
    [key: string]: RuntimeValue;
  };

  interface FileSystemSyncAccessHandle {
    close(): void;
    flush(): void;
    getSize(): number;
    read(buffer: ArrayBufferView, options?: { at?: number }): number;
    truncate(size: number): void;
    write(buffer: ArrayBufferView, options?: { at?: number }): number;
  }

  interface FileSystemFileHandle {
    createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
  }

  interface Navigator {
    deviceMemory?: number;
  }

  interface WorkerGlobalScope {
    __romWeaverCompressionWorkerKind?: "7zip-zstd" | "azahar-z3ds" | "chdman" | "dolphin-rvz";
  }

  var WorkerGlobalScope:
    | {
        prototype: WorkerGlobalScope;
        new (): WorkerGlobalScope;
      }
    | undefined;

  type RomWeaverNodeWorkerRuntime = {
    cleanupTempFiles?: (filePaths?: string[]) => void;
    cleanupTempRoots?: (roots?: string[]) => void;
    createTempFile?: (prefix: string, fileName: string, bytes: Uint8Array) => string | null | undefined;
    createTempRoot?: (prefix?: string) => string | null | undefined;
    readFileChunk?: (
      filePath: string,
      start: number,
      chunkLength: number,
    ) => Uint8Array | ArrayBuffer | ArrayBufferView;
    registerTempRoot?: (root: string) => void;
  };

  var Module: Record<string, RuntimeValue> | undefined;
  var __ROM_WEAVER_NODE_WORKER_RUNTIME: RomWeaverNodeWorkerRuntime | undefined;
  var __romWeaverCompressionWorkerKind: "7zip-zstd" | "azahar-z3ds" | "chdman" | "dolphin-rvz" | undefined;
}

export {};
