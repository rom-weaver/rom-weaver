# Webapp integration

Hosts can preload the rom-weaver webapp with remote URLs or files already stored in same-origin Origin Private File System (OPFS) storage. Both routes feed the normal input pipeline; they do not create a separate apply mode.

To add a release-page link with a patch-only recipe, follow [Add an Apply button](../how-to/add-apply-button.md).

For public MCP connections and browser agent workflows, see [Use MCP and browser agents](../how-to/use-mcp.md).

<!-- START doctoc -->
## Table of contents

- [URL sessions](#url-sessions)
- [Host remote inputs](#host-remote-inputs)
- [Ingest existing OPFS files](#ingest-existing-opfs-files)

<!-- END doctoc -->

## URL sessions

Use `?weave=<url>` to load a weave, or combine `?rom=<url>` with one or more `patch=<url>` parameters (repeat them with `&patch=`):

```text
https://rom-weaver.com/weave-patches?weave=https://example.com/release.zip
https://rom-weaver.com/apply-patches?rom=https://example.com/game.bin&patch=https://example.com/change.ips
```

To ask users to supply their own ROM, omit `rom` and supply only `patch` parameters, or use a patch-only weave. `weave` takes precedence over `rom` and `patch`; the legacy `bundle` parameter is used when `weave` is absent. Only HTTP(S) input URLs are accepted.

Build query values with `URLSearchParams` so a remote URL's own query string is not split into extra session parameters:

```js
const applyUrl = new URL("https://rom-weaver.com/weave-patches");
applyUrl.searchParams.set("weave", "https://example.com/releases/v1/release.zip");
const releaseLink = applyUrl.href;
```

For direct patches, use `searchParams.append("patch", patchUrl)` for each patch on an `/apply-patches` URL. Direct parameters preload files; use a weave to preserve authored checks, optional defaults, and execution-input choices.

The webapp reads these parameters once at startup and fetches each source in the browser, so every remote host must allow the webapp origin through CORS. Downloaded files go through the same classification, extraction, checksum, and weave-resolution pipeline as locally dropped files.

Weave metadata controls the initial patch selection and output defaults. Patches marked `optional: true` start disabled; all patches remain toggleable. Relative weave URLs resolve against the weave URL. A locally dropped weave may instead reference companion files dropped alongside it.

The legacy `/bundle-patches` route and `?bundle=<url>` parameter remain accepted.

## Host remote inputs

- Serve the actual recipe/archive/patch bytes over HTTPS. An HTML preview page or login screen is not a patch download.
- Allow the requesting origin with `Access-Control-Allow-Origin: https://rom-weaver.com`, or `*` for intentionally public, credential-free downloads. A self-hosted app needs its own origin allowed.
- Check the final download destination after redirects as well as any separate patch URLs referenced by the recipe. A link working in the address bar does not prove that a cross-origin fetch is allowed.
- Use public URLs that do not require a signed-in session. Avoid expiring or secret-bearing URLs in release pages.
- For plain JSON recipes, keep relative patch URLs valid relative to the recipe URL. For archives, include the recipe's companion patch files at the recorded paths.

If loading fails, inspect the browser's network error: check the response status, redirects, CORS response headers, and whether the body is the expected file. A host-side denial must be fixed by the host. Offer a direct download and local file selection as a fallback; do not suggest disabling browser security.

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
