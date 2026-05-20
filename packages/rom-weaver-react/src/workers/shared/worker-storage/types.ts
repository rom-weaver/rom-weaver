import type { EmscriptenFileSystem, EmscriptenWorkerModule } from "../wasm/emscripten-types.ts";

type OpfsBackend = {
  accessHandle: FileSystemSyncAccessHandle;
  closed: boolean;
  deleteQueued: boolean;
  fileHandle: FileSystemFileHandle;
  size: number;
  storageName: string;
  timestamp: number;
  truncateOnUnlink?: boolean;
};

type OutputDirectoryOwner = {
  outputDirectory: string;
};

type CleanupSupport = {
  cleanup: (filePaths?: string[]) => Promise<void>;
};

type MountedFileSystemAccess = {
  ensureMounted: (moduleObject?: EmscriptenWorkerModule | { FS?: EmscriptenFileSystem } | null) => boolean;
  ensureNode: (filePath: string) => boolean;
  linkFile?: (sourcePath: string, targetPath: string) => boolean;
  releaseFile?: (filePath: string) => void;
  usesPortableMount?: boolean;
};

type FileRetrievalSupport = {
  getFile: (filePath: string) => Promise<File | null>;
  getFilePath?: (filePath: string) => Promise<string | null>;
  getFileHandle?: (filePath: string) => FileSystemFileHandle | null;
};

type PreparedPathTracker = {
  getPreparedPaths: () => string[];
};

type FilePreparationSupport<TPrepared> = {
  prepareFile: (filePath: string) => Promise<TPrepared>;
  openFile?: (filePath: string) => Promise<TPrepared>;
};

type ByteWritingSupport = {
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<boolean>;
};

type WriteObserver = (filePath: string, rangeStart: number, rangeEnd: number) => void;

type WriteObservationSupport = {
  observeWrites?: (observer: WriteObserver) => () => void;
};

type BlobWritingSupport = {
  writeBlob: (filePath: string, blob: Blob) => Promise<boolean>;
};

type WorkerOpfsManager = OutputDirectoryOwner &
  CleanupSupport &
  MountedFileSystemAccess &
  FileRetrievalSupport &
  PreparedPathTracker &
  FilePreparationSupport<OpfsBackend | null> &
  WriteObservationSupport &
  ByteWritingSupport &
  BlobWritingSupport;

type CompressionPreparationSupport = {
  prepareFile: (filePath: string) => Promise<boolean>;
};

type CompressionOpfsManager = CleanupSupport &
  FileRetrievalSupport &
  PreparedPathTracker &
  CompressionPreparationSupport &
  Partial<MountedFileSystemAccess> &
  Pick<Partial<FilePreparationSupport<OpfsBackend | null>>, "openFile"> &
  WriteObservationSupport &
  ByteWritingSupport &
  BlobWritingSupport;

type PreparedCompressionPaths = {
  paths: {
    iso: string;
    cue: string;
    bin: string;
    createChd: string;
    rvzIso: string;
    createRvz: string;
  };
};

type PreparedCompressionOutput = OutputDirectoryOwner &
  PreparedCompressionPaths &
  CleanupSupport &
  FileRetrievalSupport &
  PreparedPathTracker &
  Partial<MountedFileSystemAccess> &
  Pick<Partial<FilePreparationSupport<OpfsBackend | null>>, "openFile"> &
  WriteObservationSupport &
  ByteWritingSupport &
  BlobWritingSupport;

export type {
  BlobWritingSupport,
  ByteWritingSupport,
  CleanupSupport,
  CompressionOpfsManager,
  FilePreparationSupport,
  FileRetrievalSupport,
  MountedFileSystemAccess,
  OpfsBackend,
  OutputDirectoryOwner,
  PreparedCompressionOutput,
  PreparedPathTracker,
  WorkerOpfsManager,
  WriteObservationSupport,
  WriteObserver,
};
