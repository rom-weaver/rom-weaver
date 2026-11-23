// Android hides the page while a native file or folder picker is open. The page gets no other sign of it.
let isInputPickerOpen = false;
let pendingPickerCalls = 0;

const setInputPickerOpen = (isOpen: boolean) => (event: Event) => {
  const { target } = event;
  if (target instanceof HTMLInputElement && target.type === "file") isInputPickerOpen = isOpen;
};

// The listeners capture, because a form may stop these events from bubbling.
if (typeof window !== "undefined") {
  window.addEventListener("click", setInputPickerOpen(true), true);
  window.addEventListener("change", setInputPickerOpen(false), true);
  window.addEventListener("cancel", setInputPickerOpen(false), true);
}

export const isFilePickerOpen = () => isInputPickerOpen || pendingPickerCalls > 0;

/** Runs a picker call such as `showDirectoryPicker`, counting its picker open until it settles. */
export const trackFilePicker = async <T>(openPicker: () => Promise<T>): Promise<T> => {
  pendingPickerCalls += 1;
  try {
    return await openPicker();
  } finally {
    pendingPickerCalls -= 1;
  }
};
