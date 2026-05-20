const isBrowserMainThread = () =>
  typeof globalThis === "object" &&
  typeof (globalThis as { window?: unknown }).window === "object" &&
  (globalThis as { window?: unknown }).window === globalThis &&
  typeof (globalThis as { document?: unknown }).document === "object";

export { isBrowserMainThread };
