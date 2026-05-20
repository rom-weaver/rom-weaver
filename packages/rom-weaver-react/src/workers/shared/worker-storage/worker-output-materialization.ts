import { createOpfsOutputManager } from "./opfs-manager.ts";
import { normalizeRelativeFilePath } from "./path-utils.ts";
import { getWorkerStorageBucketPath } from "./storage-layout.ts";
import type { WorkerOpfsManager } from "./types.ts";

type MaterializedOutput = {
  cleanupPaths: string[];
  filePath?: string;
  kind?: "file" | "opfs";
  size?: number;
};

type MaterializeOutputOptions = {
  bytes: Uint8Array;
  fallbackFileName: string;
  fileName?: string | null;
  mountPoint: string;
  navigatorObject?: Navigator | null;
  nodeTempPrefix: string;
  pathPrefix: string;
};

const managerPromises: Record<string, Promise<WorkerOpfsManager | null>> = {};
const managerRecords: Array<{ mountPoint: string; promise: Promise<WorkerOpfsManager | null> }> = [];
const materializedOutputSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let materializedOutputId = 0;

const getMaterializedOpfsManager = (
  mountPoint: string,
  navigatorObject?: Navigator | null,
): Promise<WorkerOpfsManager | null> => {
  if (!managerPromises[mountPoint]) {
    managerPromises[mountPoint] = createOpfsOutputManager({
      mountPoint,
      navigatorObject: navigatorObject || globalThis.navigator,
    }).catch(() => null);
    managerRecords.push({ mountPoint, promise: managerPromises[mountPoint] });
  }
  return managerPromises[mountPoint];
};

const createMaterializedOutputPath = (mountPoint: string, pathPrefix: string, fileName: string) => {
  const outputName = normalizeRelativeFilePath(fileName, "output.bin");
  materializedOutputId++;
  return getWorkerStorageBucketPath(
    mountPoint,
    "output",
    `${pathPrefix}-${materializedOutputSessionId}-${materializedOutputId}-${outputName}`,
    outputName,
  );
};

const materializeWorkerOutputBytes = async ({
  bytes,
  fallbackFileName,
  fileName,
  mountPoint,
  navigatorObject,
  nodeTempPrefix,
  pathPrefix,
}: MaterializeOutputOptions): Promise<MaterializedOutput> => {
  void nodeTempPrefix;
  const outputName = String(fileName || fallbackFileName || "output.bin");
  const manager = await getMaterializedOpfsManager(mountPoint, navigatorObject);
  if (manager) {
    const opfsPath = createMaterializedOutputPath(mountPoint, pathPrefix, outputName);
    const prepared = await manager.prepareFile(opfsPath);
    if (prepared && (await manager.writeFile(opfsPath, bytes))) {
      const file = await manager.getFile(opfsPath);
      if (file) {
        return {
          cleanupPaths: manager.getPreparedPaths(),
          filePath: opfsPath,
          kind: "opfs",
          size: file.size,
        };
      }
      const hostPath = await manager.getFilePath?.(opfsPath);
      if (hostPath) {
        return {
          cleanupPaths: manager.getPreparedPaths(),
          filePath: hostPath,
          kind: "file",
          size: bytes.byteLength,
        };
      }
      await manager.cleanup([opfsPath]).catch(() => undefined);
    }
  }

  throw new Error("Worker-backed output storage is not available");
};

const cleanupMaterializedOutputs = async (filePaths?: string[]) => {
  await Promise.all(managerRecords.map((record) => record.promise.then((manager) => manager?.cleanup(filePaths))));
};

export { cleanupMaterializedOutputs, materializeWorkerOutputBytes };
