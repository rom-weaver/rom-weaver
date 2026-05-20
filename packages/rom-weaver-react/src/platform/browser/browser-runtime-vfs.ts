import { getNamedSource } from "../../storage/shared/binary/source-file-utils.ts";
import { createRuntimeOutputFromVfs } from "../../storage/vfs/runtime-output.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { LargeFileVfs } from "../../storage/vfs/types.ts";
import type { RuntimeWorkerIo } from "../../types/workflow-runtime-adapter.ts";
import { createBrowserOpfsSourceRef } from "../../workers/protocol/browser-opfs-source-ref.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";

type CreateBrowserRuntimeVfsIoOptions = {
  mountPoint?: string;
  vfs: LargeFileVfs;
};

const createBrowserRuntimeVfsIo = ({
  mountPoint = WORKER_OPFS_MOUNTPOINT,
  vfs,
}: CreateBrowserRuntimeVfsIoOptions): RuntimeWorkerIo => {
  const stageSource: RuntimeWorkerIo["stageSource"] = async ({
    fallbackFileName,
    pathBucket,
    pathPrefix,
    scope,
    source,
  }) => {
    const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
    const directVfsSource = isVfsFileRef(directSource) ? directSource : isVfsFileRef(source) ? source : null;
    if (directVfsSource && directVfsSource.vfs === vfs) {
      const stat = await vfs.stat(directVfsSource.path);
      return {
        cleanup: async () => undefined,
        fileName: directVfsSource.fileName || fallbackFileName,
        filePath: directVfsSource.path,
        size: stat?.size,
      };
    }
    return createBrowserOpfsSourceRef(source, fallbackFileName, {
      bucket: pathBucket,
      mountPoint,
      pathPrefix: pathPrefix || scope,
    });
  };

  const workerIo: RuntimeWorkerIo = {
    createWorkerOutput: async (result, fallbackFileName, failureMessage) => {
      const fileName = result.fileName || result.outputRef?.fileName || result.patchFileName || fallbackFileName;
      const filePath = result.outputRef?.filePath || result.filePath || result.patchFilePath;
      if (filePath) {
        return createRuntimeOutputFromVfs(vfs, filePath, fileName, {
          cleanup: result.cleanup,
          size: result.outputRef?.size || result.size,
        });
      }
      throw new Error(failureMessage || "Worker did not return browser output");
    },
    runPathWorkerToOutput: async ({ failureMessage, fallbackFileName, outputName, pathPrefix, run, scope, source }) => {
      const workerSource = await stageSource({ fallbackFileName, pathPrefix, scope, source });
      try {
        return await workerIo.createWorkerOutput(await run(workerSource), outputName, failureMessage);
      } finally {
        await workerSource.cleanup().catch(() => undefined);
      }
    },
    stageSource,
    stageSources: (requests) => Promise.all(requests.map((request) => stageSource(request))),
  };
  return workerIo;
};

export { createBrowserRuntimeVfsIo };
