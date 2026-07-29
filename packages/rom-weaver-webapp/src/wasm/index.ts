export * from "./generated/rom-weaver-format-metadata.ts";
// Types only: `createRomWeaverBrowserOpfs` is Dedicated-Worker-only (enforced in
// browser-opfs-runtime-env.ts), and this barrel is what main-thread code imports. Re-exporting the
// factory as a value would wire the whole OPFS/WASI runtime into the app's module graph and drag it
// onto the first-paint critical path. Workers import it from the api module directly.
export type * from "./rom-weaver-browser-opfs-api.ts";
export * from "./rom-weaver-command.ts";
export type * from "./rom-weaver-types.d.ts";
