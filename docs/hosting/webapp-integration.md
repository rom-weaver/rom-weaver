# Webapp integration

Hosts can preload the rom-weaver webapp with remote URLs or files already stored in same-origin Origin Private File System (OPFS) storage. Both routes feed the normal input pipeline; they do not create a separate apply mode.

For public MCP connections and browser agent workflows, see [Use MCP and browser agents](../how-to/use-mcp.md).

<!-- START doctoc -->
## Table of contents

- [URL sessions](#url-sessions)
- [Ingest existing OPFS files](#ingest-existing-opfs-files)

<!-- END doctoc -->

## URL sessions

Use `?weave=<url>` to load a weave, or combine `?rom=<url>` with one or more `patch=<url>` parameters (repeat them with `&patch=`):

```text
https://rom-weaver.com/weave-patches?weave=https://example.com/release.zip
https://rom-weaver.com/apply-patches?rom=https://example.com/game.bin&patch=https://example.com/change.ips
```

The webapp reads these parameters once at startup and fetches each source in the browser, so every remote host must allow the webapp origin through CORS. Downloaded files go through the same classification, extraction, checksum, and weave-resolution pipeline as locally dropped files.

Weave metadata controls the initial patch selection and output defaults. Patches marked `optional: true` start disabled; all patches remain toggleable. Relative weave URLs resolve against the weave URL. A locally dropped weave may instead reference companion files dropped alongside it.

The legacy `/bundle-patches` route and `?bundle=<url>` parameter remain accepted.

## Ingest existing OPFS files

A host on the same origin can place inputs under the OPFS `rom-weaver-imports/` directory and send their mounted paths through the same pipeline. Include a weave in the list when using one; it does not need a separate option.

Code running inside this workspace can import the private webapp package and call `ingest`:

```js
import { ingest } from "@rom-weaver/webapp";

ingest([
  "/work/rom-weaver-imports/rom-weaver-weave.json",
  "/work/rom-weaver-imports/game.bin",
  "/work/rom-weaver-imports/change.ips",
]);
```

Hosts serving the prebuilt webapp can dispatch the equivalent event after its module script has loaded:

```js
document.dispatchEvent(
  new CustomEvent("rom-weaver:ingest", {
    detail: [
      "/work/rom-weaver-imports/rom-weaver-weave.json",
      "/work/rom-weaver-imports/game.bin",
      "/work/rom-weaver-imports/change.ips",
    ],
  }),
);
```

The mounted `/work/rom-weaver-imports/example.bin` path refers to `rom-weaver-imports/example.bin` below the origin's OPFS root. rom-weaver preserves that directory during startup cleanup and does not delete supplied files. OPFS is origin-private, so another origin cannot populate or ingest these paths.

For lower-level browser worker and OPFS runner APIs, see the [browser WASM runtime](../../packages/rom-weaver-webapp/src/wasm/README.md).
