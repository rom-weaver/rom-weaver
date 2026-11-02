import type { KeptRomFileRequest, KeptRomFileResponse } from "../storage/browser/kept-rom-files.ts";
import { CHROMIUM_SYNC_WRITE_NO_SPACE_COUNT } from "./browser-opfs-proxy-protocol.ts";
import { openSyncAccessHandle } from "./browser-opfs-sync-access.ts";

const DIRECTORY_NAME = "rom-weaver-kept-roms";
const FILE_NAME = /^[a-f0-9]{40}-[a-f0-9-]{36}\.rom$/;
const SNAPSHOT_ID = /^[a-f0-9-]{36}$/;

const playbackDirectory = async (root: FileSystemDirectoryHandle, create: boolean) => {
  const runtime = await root.getDirectoryHandle("runtime-output", { create });
  const emulator = await runtime.getDirectoryHandle("emulator", { create });
  return emulator.getDirectoryHandle("kept-roms", { create });
};

const snapshotName = (request: KeptRomFileRequest): string => {
  if (!(request.snapshotId && SNAPSHOT_ID.test(request.snapshotId))) throw new Error("Invalid ROM playback snapshot.");
  return `${request.snapshotId}.rom`;
};

const releaseSnapshot = async (root: FileSystemDirectoryHandle, request: KeptRomFileRequest): Promise<void> => {
  const name = snapshotName(request);
  try {
    await (await playbackDirectory(root, false)).removeEntry(name);
  } catch (error) {
    if ((error as { name?: string }).name !== "NotFoundError") throw error;
  }
};

const writeRom = async (file: FileSystemFileHandle, blob: Blob): Promise<void> => {
  const access = await openSyncAccessHandle({ fileHandle: file });
  let writeError: unknown;
  let failed = false;
  try {
    for (let position = 0; position < blob.size;) {
      const bytes = new Uint8Array(await blob.slice(position, position + 4 * 1024 * 1024).arrayBuffer());
      let offset = 0;
      while (offset < bytes.length) {
        const count = access.write(bytes.subarray(offset), { at: position + offset });
        if (count === CHROMIUM_SYNC_WRITE_NO_SPACE_COUNT || count === 0) {
          throw new DOMException("There is not enough browser storage for this ROM.", "QuotaExceededError");
        }
        if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) {
          throw new Error("The browser returned an invalid ROM write size.");
        }
        offset += count;
      }
      position += bytes.length;
    }
    access.truncate(blob.size);
    access.flush();
    if (access.getSize() !== blob.size) throw new Error("The kept ROM write was incomplete.");
  } catch (error) {
    failed = true;
    writeError = error;
  }
  try {
    access.close();
  } catch (error) {
    if (!failed) throw error;
  }
  if (failed) throw writeError;
};

const handleKeptRomFile = async (
  request: KeptRomFileRequest,
  rootPromise: Promise<FileSystemDirectoryHandle>,
): Promise<KeptRomFileResponse> => {
  const result: KeptRomFileResponse = { type: "kept-rom-file-result", requestId: request.requestId };
  try {
    const root = await rootPromise;
    if (request.action === "release") {
      await releaseSnapshot(root, request);
      return result;
    }
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: request.action === "write" });
    } catch (error) {
      if ((error as { name?: string }).name !== "NotFoundError") throw error;
      if (request.action === "list") return { ...result, names: [] };
      if (request.action === "remove") return result;
      throw error;
    }
    if (request.action === "list") {
      const names: string[] = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file" && FILE_NAME.test(name)) names.push(name);
      }
      return { ...result, names };
    }
    const name = request.name;
    if (!(name && FILE_NAME.test(name))) throw new Error("Invalid kept ROM storage name.");
    if (request.action === "remove") {
      await directory.removeEntry(name).catch((error: unknown) => {
        if ((error as { name?: string }).name !== "NotFoundError") throw error;
      });
      return result;
    }
    const file = await directory.getFileHandle(name, { create: request.action === "write" });
    if (request.action === "read") {
      const name = snapshotName(request);
      const snapshot = await (await playbackDirectory(root, true)).getFileHandle(name, { create: true });
      await writeRom(snapshot, await file.getFile());
      return { ...result, blob: await snapshot.getFile() };
    }
    if (request.action !== "write" || !(request.blob instanceof Blob)) throw new Error("A ROM file is required.");
    await writeRom(file, request.blob);
    return result;
  } catch (error) {
    return {
      ...result,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

export { handleKeptRomFile };
