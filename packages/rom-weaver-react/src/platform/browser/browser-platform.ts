import { createBrowserLargeFileVfs } from "../../storage/browser/browser-large-file-vfs.ts";
import { type BrowserRuntimePlatform, createPlatformCapabilities } from "../shared/platform.ts";

type BrowserPlatformOptions = {
  navigatorObject?: Navigator | null;
  workerFactory?: unknown;
};

type BrowserPlatformGlobals = typeof globalThis & {
  showSaveFilePicker?: unknown;
};

const browserPlatformGlobals = globalThis as BrowserPlatformGlobals;

const hasFileSystemAccess = () => typeof browserPlatformGlobals.showSaveFilePicker === "function";

const hasOpfs = (navigatorObject?: Navigator | null) => typeof navigatorObject?.storage?.getDirectory === "function";

const createBrowserPlatform = (options: BrowserPlatformOptions = {}): BrowserRuntimePlatform => ({
  capabilities: createPlatformCapabilities({
    fileSystemAccess: hasFileSystemAccess(),
    opfs: hasOpfs(options.navigatorObject || globalThis.navigator),
    workers: typeof Worker !== "undefined" || !!options.workerFactory,
  }),
  environment: "browser",
  vfs: createBrowserLargeFileVfs({
    navigatorObject: options.navigatorObject,
  }),
});

export type { BrowserPlatformOptions };
export { createBrowserPlatform };
