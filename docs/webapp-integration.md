# Webapp integration

Hosts can preload the rom-weaver webapp with remote URLs or files already
stored in same-origin Origin Private File System (OPFS) storage. Both routes
feed the normal input pipeline; they do not create a separate apply mode.

<!-- START doctoc -->
## Table of contents

- [URL sessions](#url-sessions)
- [Ingest existing OPFS files](#ingest-existing-opfs-files)

<!-- END doctoc -->

## URL sessions

Use `?bundle=<url>` to load a bundle, or combine `?rom=<url>` with one or more
`?patch=<url>` values:

```text
https://rom-weaver.com/?bundle=https://example.com/release.zip#/weave
https://rom-weaver.com/?rom=https://example.com/game.bin&patch=https://example.com/change.ips#/weave
```

The webapp reads these parameters once at startup and fetches each source in
the browser, so every remote host must allow the webapp origin through CORS.
Downloaded files go through the same classification, extraction, checksum,
and bundle-resolution pipeline as locally dropped files.

Bundle metadata controls the initial patch selection and output defaults.
Patches marked `optional: true` start disabled; all patches remain toggleable.
Relative bundle URLs resolve against the bundle URL. A locally dropped bundle
may instead reference companion files dropped alongside it.

## Ingest existing OPFS files

A host on the same origin can place inputs under the OPFS
`rom-weaver-imports/` directory and send their mounted paths through the same
pipeline. Include a bundle in the list when using one; it does not need a
separate option.

Applications importing the package can call `ingest`:

```js
import { ingest } from "rom-weaver-webapp";

ingest([
  "/work/rom-weaver-imports/rom-weaver-bundle.json",
  "/work/rom-weaver-imports/game.bin",
  "/work/rom-weaver-imports/change.ips",
]);
```

Hosts serving the prebuilt webapp can dispatch the equivalent event after its
module script has loaded:

```js
document.dispatchEvent(
  new CustomEvent("rom-weaver:ingest", {
    detail: [
      "/work/rom-weaver-imports/rom-weaver-bundle.json",
      "/work/rom-weaver-imports/game.bin",
      "/work/rom-weaver-imports/change.ips",
    ],
  }),
);
```

The mounted `/work/rom-weaver-imports/example.bin` path refers to
`rom-weaver-imports/example.bin` below the origin's OPFS root. rom-weaver
preserves that directory during startup cleanup and does not delete supplied
files. OPFS is origin-private, so another origin cannot populate or ingest
these paths.

For lower-level browser worker and OPFS runner APIs, see the
[browser WASM runtime](../packages/rom-weaver-webapp/src/wasm/README.md).
