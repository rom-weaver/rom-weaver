# Webapp integration

Preload rom-weaver with remote files or same-origin Origin Private File System (OPFS) inputs. Both use the normal classification, extraction, checksum, and weave pipeline. For agent connections, see [Use MCP](../how-to/use-mcp.md).

<!-- START doctoc -->
## Table of contents

- [Add an Apply button](#add-an-apply-button)
- [URL sessions](#url-sessions)
- [Host remote inputs](#host-remote-inputs)
- [Ingest existing OPFS files](#ingest-existing-opfs-files)

<!-- END doctoc -->

## Add an Apply button

[Create and test a patch-only weave](../how-to/create-bundles.md) with source checks, ordered patches, and optional add-ons. Leave **Include ROM in weave** clear; readers supply their own ROM. Test every optional combination you advertise and keep checksum validation enabled.

Host the archive at a versioned public HTTPS URL with CORS enabled. Replace the encoded example URL in this release-page link:

```html
<a href="https://rom-weaver.com/weave-patches?weave=https%3A%2F%2Fexample.com%2Frelease.zip">Apply this recipe</a>
```

For a Markdown release page or README, use:

```md
[Apply this recipe](https://rom-weaver.com/weave-patches?weave=https%3A%2F%2Fexample.com%2Frelease.zip)
```

The link opens **Weave** with the recipe preloaded. Tell readers to add their matching ROM, review the patches, expand **Apply**, and choose **APPLY & DOWNLOAD**. Opening the link does not apply patches automatically.

Beside it, give the source's region, revision, header state and checksum; supported optional choices; expected output checksums; and a direct archive download. Archive and ROM checksums describe different bytes. Keep private tokens out of shared links.

Open the published link in a fresh browser without signing into the host. Check the recipe, supply the source locally, and verify the output and emulator. Check that a wrong sample source shows a mismatch. Reuse the [existing two-patch demo](https://github.com/user-attachments/assets/558b4f4d-640c-410e-a866-cd9ff97ac84c) or [homebrew practice run](../tutorials/first-patch.md) to introduce readers to the workflow.

## URL sessions

Use `weave` for a recipe or archive. For individual patches, repeat `patch` and omit `rom` when readers supply their own ROM:

```text
https://rom-weaver.com/weave-patches?weave=https://example.com/release.zip
https://rom-weaver.com/apply-patches?patch=https://example.com/first.bps&patch=https://example.com/second.bps
```

Encode complete remote URLs, including their query strings:

```js
const link = new URL("https://rom-weaver.com/weave-patches");
link.searchParams.set("weave", "https://example.com/release.zip");
```

Parameters are read once at startup. Only HTTP(S) URLs are accepted. `weave` overrides `rom` and `patch`; legacy `bundle` is used when `weave` is absent. `/bundle-patches` remains accepted. Neither link applies patches automatically.

Weaves preserve checks, order, optional defaults, and output metadata; direct patch links only preload files. `optional: true` starts disabled; all patches remain toggleable. Remote relative URLs resolve against the weave URL. Local weaves can use companion files dropped alongside them.

## Host remote inputs

Serve actual files, not HTML previews or login pages. Every remote host, including redirected destinations and referenced patches, must allow the app origin with `Access-Control-Allow-Origin: https://rom-weaver.com` (or `*` for public, credential-free files). Self-hosted apps need their own origin allowed.

If loading fails, check response status, redirects, CORS headers, and file contents. A working address-bar download does not prove cross-origin access. Offer direct download and local file selection as the fallback; never ask readers to disable browser security.

## Ingest existing OPFS files

A same-origin host can store files below OPFS `rom-weaver-imports/` and ingest their mounted paths. Include the recipe when using one.

Inside this workspace, use the private webapp package:

```js
import { ingest } from "@rom-weaver/webapp";

ingest([
  "/work/rom-weaver-imports/rom-weaver-weave.json",
  "/work/rom-weaver-imports/game.bin",
  "/work/rom-weaver-imports/change.ips",
]);
```

For the prebuilt app, dispatch after its module loads:

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

`/work/rom-weaver-imports/example.bin` maps to OPFS `rom-weaver-imports/example.bin`. Startup cleanup preserves this directory and supplied files. Other origins cannot populate it. See the [browser WASM runtime](../../packages/rom-weaver-webapp/src/wasm/README.md) for worker APIs.
