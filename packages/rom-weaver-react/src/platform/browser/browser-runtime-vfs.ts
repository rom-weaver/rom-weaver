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

const emitBrowserRuntimeVfsTrace = (message: string, details?: Record<string, unknown>) => {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-runtime-vfs: ${message}`, details || {});
};

const createBrowserRuntimeVfsIo = ({
  mountPoint = WORKER_OPFS_MOUNTPOINT,
  vfs,
}: CreateBrowserRuntimeVfsIoOptions): RuntimeWorkerIo => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const statWithRetries = async (filePath: string) => {
    let stat = await vfs.stat(filePath);
    if (stat) return stat;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await wait(25 * (attempt + 1));
      stat = await vfs.stat(filePath);
      if (stat) return stat;
    }
    return null;
  };
  const assertStagedPath = async (filePath: string) => {
    const stat = await statWithRetries(filePath);
    if (!stat) throw new Error(`Browser worker input path is not available: ${filePath}`);
    return stat;
  };
  const stageSource: RuntimeWorkerIo["stageSource"] = async ({
    fallbackFileName,
    pathBucket,
    pathPrefix,
    scope,
    source,
  }) => {
    emitBrowserRuntimeVfsTrace("stageSource start", {
      fallbackFileName,
      pathBucket,
      pathPrefix,
      scope,
    });
    const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
    const directVfsSource = isVfsFileRef(directSource) ? directSource : isVfsFileRef(source) ? source : null;
    if (directVfsSource && directVfsSource.vfs === vfs) {
      emitBrowserRuntimeVfsTrace("stageSource using direct vfs source", {
        fileName: directVfsSource.fileName || fallbackFileName,
        filePath: directVfsSource.path,
        scope,
      });
      const stat = await assertStagedPath(directVfsSource.path);
      return {
        cleanup: async () => undefined,
        fileName: directVfsSource.fileName || fallbackFileName,
        filePath: directVfsSource.path,
        size: stat?.size,
      };
    }
    const stageFromSource = () =>
      createBrowserOpfsSourceRef(source, fallbackFileName, {
        bucket: pathBucket,
        mountPoint,
        pathPrefix: pathPrefix || scope,
      });
    emitBrowserRuntimeVfsTrace("stageSource creating source ref", {
      fallbackFileName,
      pathBucket,
      pathPrefix: pathPrefix || scope,
      scope,
    });
    let staged = await stageFromSource();
    emitBrowserRuntimeVfsTrace("stageSource source ref created", {
      fileName: staged.fileName,
      filePath: staged.filePath,
      size: staged.size,
      virtual: !!staged.virtual,
    });
    if (staged.virtual) return staged;
    try {
      const stat = await assertStagedPath(staged.filePath);
      emitBrowserRuntimeVfsTrace("stageSource path verified", {
        filePath: staged.filePath,
        size: staged.size ?? stat.size,
      });
      return {
        ...staged,
        size: staged.size ?? stat.size,
      };
    } catch (error) {
      emitBrowserRuntimeVfsTrace("stageSource path verify failed, retrying", {
        filePath: staged.filePath,
        message: error instanceof Error ? error.message : String(error),
      });
      await staged.cleanup().catch(() => undefined);
      staged = await stageFromSource();
      try {
        const stat = await assertStagedPath(staged.filePath);
        emitBrowserRuntimeVfsTrace("stageSource retry path verified", {
          filePath: staged.filePath,
          size: staged.size ?? stat.size,
        });
        return {
          ...staged,
          size: staged.size ?? stat.size,
        };
      } catch (retryError) {
        emitBrowserRuntimeVfsTrace("stageSource retry failed", {
          filePath: staged.filePath,
          message: retryError instanceof Error ? retryError.message : String(retryError),
        });
        await staged.cleanup().catch(() => undefined);
        throw retryError instanceof Error ? retryError : error;
      }
    }
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
