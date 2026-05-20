type RomWeaverNodeWorkerRuntime = {
  cleanupTempFiles?: (filePaths?: string[]) => void;
  cleanupTempRoots?: (roots?: string[]) => void;
  createTempFile?: (prefix: string, fileName: string, bytes: Uint8Array) => string | null | undefined;
  createTempRoot?: (prefix?: string) => string | null | undefined;
  readFileChunk?: (filePath: string, start: number, chunkLength: number) => Uint8Array | ArrayBuffer | ArrayBufferView;
  registerTempRoot?: (root: string) => void;
};

const getNodeWorkerRuntimeRoot = () =>
  globalThis as typeof globalThis & {
    __ROM_WEAVER_NODE_WORKER_RUNTIME?: RomWeaverNodeWorkerRuntime | null;
  };

const getNodeWorkerRuntime = (): RomWeaverNodeWorkerRuntime | null => {
  const runtime = getNodeWorkerRuntimeRoot().__ROM_WEAVER_NODE_WORKER_RUNTIME;
  return runtime && typeof runtime === "object" ? runtime : null;
};

const getRuntimeFunction = <TKey extends keyof RomWeaverNodeWorkerRuntime>(key: TKey) => {
  const capability = getNodeWorkerRuntime()?.[key];
  return typeof capability === "function" ? capability : null;
};

const hasNodeWorkerRuntimePathReadSupport = () => !!getRuntimeFunction("readFileChunk");
const hasNodeWorkerRuntimeTempFileSupport = () =>
  !!getRuntimeFunction("createTempFile") && !!getRuntimeFunction("cleanupTempFiles");

const readNodeWorkerFileChunk = (filePath: string, start: number, chunkLength: number) => {
  const readFileChunk = getRuntimeFunction("readFileChunk");
  if (!readFileChunk) throw new Error("Worker path reads are not available");
  return readFileChunk(filePath, start, chunkLength);
};

const createNodeWorkerTempFile = (prefix: string, fileName: string, bytes: Uint8Array) => {
  const createTempFile = getRuntimeFunction("createTempFile");
  return createTempFile ? createTempFile(prefix, fileName, bytes) : null;
};

const createNodeWorkerTempRoot = (prefix?: string) => {
  const createTempRoot = getRuntimeFunction("createTempRoot");
  return createTempRoot ? createTempRoot(prefix) : null;
};

const registerNodeWorkerTempRoot = (root: string) => {
  const registerTempRoot = getRuntimeFunction("registerTempRoot");
  if (registerTempRoot) registerTempRoot(root);
};

const cleanupNodeWorkerTempFiles = (filePaths?: string[]) => {
  const cleanupTempFiles = getRuntimeFunction("cleanupTempFiles");
  if (cleanupTempFiles) cleanupTempFiles(filePaths);
};

const cleanupNodeWorkerTempRoots = (roots?: string[]) => {
  const cleanupTempRoots = getRuntimeFunction("cleanupTempRoots");
  if (cleanupTempRoots) cleanupTempRoots(roots);
};

export type { RomWeaverNodeWorkerRuntime };
export {
  cleanupNodeWorkerTempFiles,
  cleanupNodeWorkerTempRoots,
  createNodeWorkerTempFile,
  createNodeWorkerTempRoot,
  getNodeWorkerRuntime,
  hasNodeWorkerRuntimePathReadSupport,
  hasNodeWorkerRuntimeTempFileSupport,
  readNodeWorkerFileChunk,
  registerNodeWorkerTempRoot,
};
