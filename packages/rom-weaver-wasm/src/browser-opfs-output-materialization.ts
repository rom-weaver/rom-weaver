import * as wasiShim from '@bjorn3/browser_wasi_shim';
import { BrowserOpfsRandomAccessFile } from './browser-opfs-io-adapters.ts';
import { OPFS_COPY_CHUNK_SIZE } from './browser-opfs-constants.ts';
import { openSyncAccessHandle, writableSyncAccessMode } from './browser-opfs-sync-access.ts';

export async function flushBrowserOpfsMounts(mounts, trace) {
  for (const mount of mounts) {
    await flushInMemoryEntriesToOpfs(mount.directoryHandle, mount.contents);
    await replaceScratchBackedEntriesWithOpfsHandles({
      directoryHandle: mount.directoryHandle,
      entries: mount.contents,
      mount,
    });
    mount.resetScratchPool?.({ trace });
  }
}

async function replaceScratchBackedEntriesWithOpfsHandles({
  directoryHandle,
  entries,
  mount,
}) {
  for (const [name, entry] of entries) {
    if (isRandomAccessFileInodeLike(entry)) {
      if (!entry.scratchBacked) continue;
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      const syncHandle = await openSyncAccessHandle({
        fileHandle,
        mode: writableSyncAccessMode(mount.syncAccessMode),
      });
      const file = new BrowserOpfsRandomAccessFile(syncHandle);
      mount.trackOwnedFile(file);
      entry.file = file;
      entry.scratchBacked = false;
      continue;
    }
    if (entry instanceof wasiShim.Directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(name, { create: true });
      await replaceScratchBackedEntriesWithOpfsHandles({
        directoryHandle: childHandle,
        entries: entry.contents,
        mount,
      });
    }
  }
}

async function flushInMemoryEntriesToOpfs(directoryHandle, entries) {
  for (const [name, entry] of entries) {
    if (isRandomAccessFileInodeLike(entry)) {
      if (entry.scratchBacked) {
        const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
        await copyRandomAccessFileToHandle(entry.file, fileHandle);
      } else if (typeof entry.file?.flush === 'function') {
        entry.file.flush();
      }
      continue;
    }

    if (entry instanceof wasiShim.Directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(name, { create: true });
      await flushInMemoryEntriesToOpfs(childHandle, entry.contents);
      continue;
    }

    if (entry instanceof wasiShim.File) {
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      await writeFileHandle(fileHandle, entry.data);
    }
  }
}

function isRandomAccessFileInodeLike(entry) {
  return Boolean(
    entry
      && typeof entry === 'object'
      && 'file' in entry
      && typeof entry.path_open === 'function'
      && typeof entry.stat === 'function'
  );
}

export async function copyRandomAccessFileToHandle(source, fileHandle) {
  const size = Number(source.size());
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
      accessHandle.truncate(0);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(buffer.byteLength, size - offset);
        const view = buffer.subarray(0, length);
        const read = source.readAt(offset, view);
        if (read <= 0) break;
        accessHandle.write(view.subarray(0, read), { at: offset });
        offset += read;
      }
      accessHandle.truncate(offset);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  let writeError = null;
  try {
    const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const view = buffer.subarray(0, length);
      const read = source.readAt(offset, view);
      if (read <= 0) break;
      await writable.write({
        data: view.slice(0, read),
        position: offset,
        type: 'write',
      });
      offset += read;
    }
    await writable.truncate(size);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritableStream(writable, writeError);
  }
}

async function writeFileHandle(fileHandle, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      accessHandle.truncate(0);
      if (bytes.byteLength > 0) accessHandle.write(bytes, { at: 0 });
      accessHandle.truncate(bytes.byteLength);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  let writeError = null;
  try {
    await writable.write(bytes);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritableStream(writable, writeError);
  }
}

async function closeWritableStream(writable, priorError) {
  if (priorError) {
    if (typeof writable.abort === 'function') {
      try {
        await writable.abort(priorError);
      } catch {
        // Preserve the write/truncate error that caused the stream to enter an errored state.
      }
    } else {
      try {
        await writable.close();
      } catch {
        // Preserve the write/truncate error that caused the stream to enter an errored state.
      }
    }
    throw priorError;
  }
  await writable.close();
}
