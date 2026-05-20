import { createRelativeModuleWorkerFromBrowserFactory } from "./worker-factory.ts";
import type { CompressionWorkerKind } from "./worker-protocol.ts";
import { compressionWorkerDescriptors, type WorkerDescriptor, workerDescriptors } from "./worker-registry.ts";

type WorkerAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
};

const EMBED_WORKER_FILE_BY_SOURCE_PATH = {
  "../compression-7zip-zstd/compression-7zip.worker.ts": "compression-7zip.worker.js",
  "../compression-azahar-z3ds/compression-z3ds.worker.ts": "compression-z3ds.worker.js",
  "../compression-chdman/compression-chd.worker.ts": "compression-chd.worker.js",
  "../compression-dolphin-rvz/compression-rvz.worker.ts": "compression-rvz.worker.js",
  "../patch-checksum/patch-checksum.worker.ts": "patch-checksum.worker.js",
} as const satisfies Record<string, string>;

const resolveWorkerModuleUrl = (relativePath: string, fallbackUrl: URL) => {
  const root = globalThis as WorkerAssetRoot;
  const baseUrl = typeof root.__romWeaverWorkerBaseUrl === "string" ? root.__romWeaverWorkerBaseUrl.trim() : "";
  if (!baseUrl) return fallbackUrl;
  const mappedFileName =
    EMBED_WORKER_FILE_BY_SOURCE_PATH[relativePath as keyof typeof EMBED_WORKER_FILE_BY_SOURCE_PATH] || "";
  const fallbackFileName = fallbackUrl.pathname.split("/").pop()?.replace(/\.ts$/i, ".js") || "";
  const fileName = mappedFileName || fallbackFileName;
  if (!fileName) return fallbackUrl;
  try {
    return new URL(fileName, baseUrl);
  } catch (_error) {
    return fallbackUrl;
  }
};

const workerBrowserFactories = {
  "7zip-zstd": () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../compression-7zip-zstd/compression-7zip.worker.ts",
        new URL("../compression-7zip-zstd/compression-7zip.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors["7zip-zstd"].name,
        type: "module",
      },
    ),
  "azahar-z3ds": () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../compression-azahar-z3ds/compression-z3ds.worker.ts",
        new URL("../compression-azahar-z3ds/compression-z3ds.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors["azahar-z3ds"].name,
        type: "module",
      },
    ),
  chdman: () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../compression-chdman/compression-chd.worker.ts",
        new URL("../compression-chdman/compression-chd.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors.chdman.name,
        type: "module",
      },
    ),
  checksum: () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../patch-checksum/patch-checksum.worker.ts",
        new URL("../patch-checksum/patch-checksum.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors.checksum.name,
        type: "module",
      },
    ),
  "dolphin-rvz": () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../compression-dolphin-rvz/compression-rvz.worker.ts",
        new URL("../compression-dolphin-rvz/compression-rvz.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors["dolphin-rvz"].name,
        type: "module",
      },
    ),
  patch: () =>
    new Worker(
      resolveWorkerModuleUrl(
        "../patch-checksum/patch-checksum.worker.ts",
        new URL("../patch-checksum/patch-checksum.worker.ts", import.meta.url),
      ),
      {
        name: workerDescriptors.patch.name,
        type: "module",
      },
    ),
} as const satisfies Record<keyof typeof workerDescriptors, () => Worker>;

const createWorkerFactory =
  ({ name, path }: WorkerDescriptor, createBrowserWorker: () => Worker) =>
  () =>
    createRelativeModuleWorkerFromBrowserFactory(createBrowserWorker, path, import.meta.url, {
      name,
      type: "module",
    });

const createPatchWorkerInstance = createWorkerFactory(workerDescriptors.patch, workerBrowserFactories.patch);
const createCompressionWorkerInstance = (kind: CompressionWorkerKind = "7zip-zstd") => {
  const descriptor = compressionWorkerDescriptors[kind];
  return createWorkerFactory(descriptor, workerBrowserFactories[kind])();
};
const createChecksumWorkerInstance = createWorkerFactory(workerDescriptors.checksum, workerBrowserFactories.checksum);
const createChdCompressionWorkerInstance = createWorkerFactory(workerDescriptors.chdman, workerBrowserFactories.chdman);
const createRvzCompressionWorkerInstance = createWorkerFactory(
  workerDescriptors["dolphin-rvz"],
  workerBrowserFactories["dolphin-rvz"],
);
const createZ3dsCompressionWorkerInstance = createWorkerFactory(
  workerDescriptors["azahar-z3ds"],
  workerBrowserFactories["azahar-z3ds"],
);

export {
  compressionWorkerDescriptors,
  createChdCompressionWorkerInstance,
  createChecksumWorkerInstance,
  createCompressionWorkerInstance,
  createPatchWorkerInstance,
  createRvzCompressionWorkerInstance,
  createZ3dsCompressionWorkerInstance,
  resolveWorkerModuleUrl,
  workerDescriptors,
};
