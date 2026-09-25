export const DEFAULT_BROWSER_THREAD_COUNT = 4;
export const MAX_BROWSER_THREAD_COUNT = 64;

export const clampBrowserThreadCount = (hardwareConcurrency: number): number =>
  Math.min(MAX_BROWSER_THREAD_COUNT, Math.max(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
