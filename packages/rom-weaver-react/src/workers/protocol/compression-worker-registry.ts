import type { WorkerTransport } from "../../types/worker-messages.ts";
import { createCompressionWorkerInstance } from "./worker-factories.ts";
import type { CompressionWorkerKind } from "./worker-protocol.ts";
import {
  type getCompressionWorkerDescriptor as getProtocolCompressionWorkerDescriptor,
  getRegistryDescriptor,
  compressionWorkerDescriptors as protocolCompressionWorkerDescriptors,
} from "./worker-registry.ts";

export type {
  CompressionWorkerDescriptor as ProtocolCompressionWorkerDescriptor,
  NormalizedWorkerSource,
} from "./worker-registry.ts";

type CompressionWorkerDescriptor = ReturnType<typeof getProtocolCompressionWorkerDescriptor> & {
  createWorker: () => WorkerTransport;
};

const compressionWorkerDescriptors: Record<CompressionWorkerKind, CompressionWorkerDescriptor> = {
  "7zip-zstd": {
    ...protocolCompressionWorkerDescriptors["7zip-zstd"],
    createWorker: () => createCompressionWorkerInstance("7zip-zstd") as WorkerTransport,
  },
  "azahar-z3ds": {
    ...protocolCompressionWorkerDescriptors["azahar-z3ds"],
    createWorker: () => createCompressionWorkerInstance("azahar-z3ds") as WorkerTransport,
  },
  chdman: {
    ...protocolCompressionWorkerDescriptors.chdman,
    createWorker: () => createCompressionWorkerInstance("chdman") as WorkerTransport,
  },
  "dolphin-rvz": {
    ...protocolCompressionWorkerDescriptors["dolphin-rvz"],
    createWorker: () => createCompressionWorkerInstance("dolphin-rvz") as WorkerTransport,
  },
};

const getCompressionWorkerDescriptor = (kind: CompressionWorkerKind) =>
  getRegistryDescriptor(compressionWorkerDescriptors, kind, "compression worker kind");

export type { CompressionWorkerDescriptor };
export { compressionWorkerDescriptors, getCompressionWorkerDescriptor };
