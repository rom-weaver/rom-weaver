import { releaseLargeEntries } from "../public/react/emulator-session-store.ts";

// Preparing this much input can need the memory a paused disc-sized Test game holds.
const LARGE_INPUT_BYTES = 1024 ** 3;

type SizedFiles = ArrayLike<{ size: number }> | null | undefined;

const totalBytes = (files: SizedFiles) => Array.from(files ?? []).reduce((sum, file) => sum + file.size, 0);

/**
 * Close a paused disc-sized Test game when more than 1 GiB is picked or dropped in one go outside Test. The
 * capture-phase document listeners run before the tool's own handler starts reading the files. Test is left out:
 * it closes the paused game itself before it loads another. Returns the function that removes the listeners.
 */
const releaseLargeEntriesOnLargeInput = (isTestShown: () => boolean) => {
  const release = (files: SizedFiles) => {
    if (!isTestShown() && totalBytes(files) > LARGE_INPUT_BYTES) releaseLargeEntries({ announce: true });
  };
  const handleChange = (event: Event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "file") release(event.target.files);
  };
  const handleDrop = (event: DragEvent) => release(event.dataTransfer?.files);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("drop", handleDrop, true);
  return () => {
    document.removeEventListener("change", handleChange, true);
    document.removeEventListener("drop", handleDrop, true);
  };
};

export { releaseLargeEntriesOnLargeInput };
