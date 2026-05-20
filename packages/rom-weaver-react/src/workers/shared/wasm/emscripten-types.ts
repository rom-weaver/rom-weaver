import type { WorkerRuntimeRecord, WorkerRuntimeValue } from "../../protocol/worker-runtime-payloads.ts";
import type { OpfsBackend } from "../worker-storage/types.ts";

type EmscriptenFsNode = {
  backend?: OpfsBackend;
  contents: Record<string, EmscriptenFsNode>;
  id?: number;
  mode?: number;
  node_ops?: EmscriptenNodeOps;
  stream_ops?: EmscriptenStreamOps;
  timestamp?: number;
};

type EmscriptenFsStream = {
  node: EmscriptenFsNode;
  position: number;
};

type EmscriptenNodeOps = {
  getattr?: (node: EmscriptenFsNode) => object;
  setattr?: (node: EmscriptenFsNode, attr: { mode?: number; timestamp?: number; size?: number }) => void;
  lookup?: (parent: EmscriptenFsNode, name: string) => EmscriptenFsNode;
  mknod?: (parent: EmscriptenFsNode, name: string, mode: number) => EmscriptenFsNode;
  unlink?: (parent: EmscriptenFsNode, name: string) => void;
  readdir?: (node: EmscriptenFsNode) => string[];
};

type EmscriptenStreamOps = {
  close?: (stream: EmscriptenFsStream) => void;
  llseek?: (stream: EmscriptenFsStream, offset: number, whence: number) => number;
  read?: (stream: EmscriptenFsStream, buffer: Uint8Array, offset: number, length: number, position: number) => number;
  write?: (stream: EmscriptenFsStream, buffer: Uint8Array, offset: number, length: number, position?: number) => number;
};

type EmscriptenFileSystem = {
  ErrnoError: new (errno: number) => Error;
  createNode: (parent: EmscriptenFsNode | null, name: string, mode: number, dev: number) => EmscriptenFsNode;
  getPath: (node: EmscriptenFsNode) => string;
  lookupPath: (filePath: string) => { node: EmscriptenFsNode };
  mkdirTree: (filePath: string) => void;
  mknod: (filePath: string, mode: number, dev: number) => void;
  readFile?: (filePath: string) => Uint8Array | ArrayBuffer | ArrayBufferView;
  rename?: (oldPath: string, newPath: string) => void;
  stat?: (filePath: string) => { mode: number; size?: number };
  symlink?: (sourcePath: string, targetPath: string) => void;
  mount: (
    fileSystem: { mount: (mount?: WorkerRuntimeRecord) => EmscriptenFsNode | null } | WorkerRuntimeValue,
    options: WorkerRuntimeRecord,
    mountPoint: string,
  ) => void;
  unlink: (filePath: string) => void;
  unmount?: (filePath: string) => void;
  writeFile: (filePath: string, bytes: Uint8Array) => void;
};

type WasmToolRuntime = {
  threaded?: boolean;
  threadCount?: number;
  run?: (
    argv: string[],
    options?: Record<string, WorkerRuntimeValue>,
  ) => Promise<{ status: number; stdout: string; stderr: string }>;
};

type EmscriptenWorkerModule = WorkerRuntimeRecord & {
  FS?: EmscriptenFileSystem;
  Module?: EmscriptenWorkerModule;
  NODEFS?: { mount: (mount?: WorkerRuntimeRecord) => EmscriptenFsNode | null };
  OPFS?: { createBackend?: (...args: WorkerRuntimeValue[]) => WorkerRuntimeValue };
  __azaharZ3dsThreaded?: boolean;
  __wasmToolThreadCount?: number;
  dolphinRvz?: WasmToolRuntime;
  locateFile?: (path: string, scriptDirectory?: string) => string;
  onRuntimeInitialized?: (() => void) | null;
  threadCount?: number;
  wasmTool?: WasmToolRuntime;
  wasmToolName?: string;
};

export type {
  EmscriptenFileSystem,
  EmscriptenFsNode,
  EmscriptenFsStream,
  EmscriptenNodeOps,
  EmscriptenStreamOps,
  EmscriptenWorkerModule,
  WasmToolRuntime,
};
