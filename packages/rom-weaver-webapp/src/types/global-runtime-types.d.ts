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

  var WorkerGlobalScope:
    | {
        prototype: WorkerGlobalScope;
        new (): WorkerGlobalScope;
      }
    | undefined;
}

export {};
