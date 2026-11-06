/**
 * Whether this browser can write into a picked folder and rename the files in it. Kept apart from
 * the folder writer so the page knows at once, before the writer has loaded.
 */
const canWritePlaylistFolders = () =>
  typeof window !== "undefined" &&
  typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function" &&
  typeof FileSystemFileHandle !== "undefined" &&
  typeof (FileSystemFileHandle.prototype as { move?: unknown }).move === "function" &&
  typeof indexedDB !== "undefined" &&
  !!globalThis.navigator?.locks;

export { canWritePlaylistFolders };
