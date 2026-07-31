# Mobile Safari verification

rom-weaver's browser runtime needs secure-context APIs, cross-origin isolation,
`SharedArrayBuffer`, `Atomics.waitAsync`, workers, and OPFS. Docker and desktop
emulation can catch some WebKit regressions, but they do not replace real iOS
Safari for file picker, storage quota, memory pressure, download, and PWA
behavior.

<!-- START doctoc -->
## Table of contents

- [Automation ladder](#automation-ladder)
- [Real device setup](#real-device-setup)
- [Worker lifetime on mobile](#worker-lifetime-on-mobile)
- [Runtime preflight](#runtime-preflight)
- [Manual scenarios](#manual-scenarios)

<!-- END doctoc -->

## Automation ladder

Use these checks from cheapest to most faithful:

0. Fast local E2E gate (CLI, WASM, isolated Chromium files, and the real webapp
   entry point run concurrently after the WASM build):

   ```bash
   mise run test-e2e-fast
   ```

1. Static compatibility:

   ```bash
   cd packages/rom-weaver-webapp
   npm run lint:browser-compat
   ```

2. Chromium browser suite, the default local gate:

   ```bash
   cd packages/rom-weaver-webapp
   npm run test:browser
   ```

3. WebKit smoke check. This uses Playwright's WebKit build, not branded Safari,
   so treat it as an early warning only:

   ```bash
   cd packages/rom-weaver-webapp
   npm run test:browser:webkit:smoke
   ```

   If Playwright reports a missing WebKit executable, install it once:

   ```bash
   cd packages/rom-weaver-webapp
   npx playwright install webkit
   ```

4. Optional full WebKit suite:

   ```bash
   cd packages/rom-weaver-webapp
   npm run test:browser:webkit
   ```

5. Xcode iOS Simulator Safari for repeatable local browser checks on macOS.

6. Real iPhone or iPad Safari for final verification.

The exhaustive valid codec/level/thread interaction matrix runs nightly and can
also be started locally with:

```bash
mise run test-e2e-nightly
```

Cloud real-device providers are the CI option when a local device farm is not
available. BrowserStack, Sauce Labs, and LambdaTest can run real iOS Safari; use
a secure tunnel for local or staging builds.

## Real device setup

Generate the adversarial archive corpus and start the HTTPS dev server on the
LAN:

```bash
mise run test-e2e-ios
```

To add known failing archives without committing or uploading them:

```bash
mise run test-e2e-ios -- --local-corpus /path/to/private/archives
```

Generated files and linked/copied private cases stay under the gitignored
`target/e2e-corpus/` directory. The server exposes only files named by its
corpus manifest.

Open the printed `https://<mac-lan-ip>:5173/` URL on the iPhone or iPad. The
origin must be HTTPS and trusted by iOS; plain LAN HTTP is not enough for this
runtime. If the self-signed certificate blocks testing, use a trusted tunnel or
install and trust the local certificate on the device.

For the full browser-worker matrix on real iOS Safari, open:

```text
https://<mac-lan-ip>:5173/mobile-safari-matrix.html
```

Tap **Run fast matrix** for format coverage, **Run exhaustive matrix** for every
valid codec/level/thread interaction, or **Run archive stress** for the generated
large-archive ladder. The page runs in the device browser, creates a
temporary OPFS workspace, and exercises:

- container round-trips for zip, 7z, chd, and z3ds
- expected unsupported/failure paths for extract-only or invalid synthetic
  inputs, including zipx, tar-family formats, standalone stream formats, cso,
  rar, pbp, gcz, wbfs, wia, tgc, nfs, rvz, and xiso
- patch create/apply coverage for the patch registry, including direct apply
  fixtures for HDiffPatch, BSP, xdelta, and VCDIFF fixture paths
- 200 MiB and 933 MiB 7z cases, high-ratio and incompressible archives,
  thousands of entries, and three-level nesting

Archive downloads stream directly into OPFS, so the harness does not first
duplicate the entire input in the JavaScript heap. Each case validates output
counts, sizes, and SHA-256 where available, then terminates its worker and
removes its workspace. The stress profile stops on the first failure.

The matrix requests a screen wake lock while a run is active, releases it when
the run finishes, and reacquires it after the page returns to the foreground.
iOS may still suspend the test if the browser is manually backgrounded.

## Worker lifetime on mobile

Each command uses a shared `WebAssembly.Memory`. On real iOS hardware, creating
successive memories in one long-lived worker retained enough address-space
reservations that the seventh command failed before WASM started. Reusing one
memory across fresh WASI CLI instances was also invalid because allocator and
process state cannot be restarted safely in the old heap.

The workaround is deliberately limited to Apple mobile WebKit (all iPhone and
iPad browsers): cap shared WASM memory at the existing 1 GiB mobile ceiling and
terminate a worker after its command. Fresh workers still reuse the compiled
`WebAssembly.Module`, browser asset cache, and OPFS data. There is no run-count
threshold or delay because the WebAssembly API provides no explicit memory
disposal operation.

Android keeps worker reuse enabled. The retained-reservation failure is
documented in WebKit, not Chromium/V8, and the reused-worker exhaustive matrix
passes under Chromium. Android still uses the general 1 GiB mobile operation
ceiling to prevent concurrent jobs from overcommitting device memory.

References:

- [WebKit shared WASM worker retention](https://bugs.webkit.org/show_bug.cgi?id=281657)
- [WebKit iOS shared-memory OOM](https://bugs.webkit.org/show_bug.cgi?id=255103)
- [WebAssembly `Memory` API](https://webassembly.github.io/spec/js-api/#memories)
- [V8 shared-memory worker GC coverage](https://chromium.googlesource.com/v8/v8.git/+/refs/heads/main/test/mjsunit/wasm/shared-memory-worker-simple-gc.js)

Use **Copy report** or **Download report** after the run finishes and attach that
JSON to Mobile Safari bug reports. The active archive case is persisted before
it starts; if iOS reloads or kills the tab, reopening the page records that case
as interrupted instead of silently restarting it.

Enable inspection:

- Mac Safari: Settings > Advanced > Show features for web developers.
- iOS Safari: Settings > Apps > Safari > Advanced > Web Inspector.
- Connect the device to the Mac, then inspect the tab from Safari's Develop
  menu. Xcode Simulator Safari appears in the same Develop menu.

## Runtime preflight

The webapp exposes a console helper for device captures:

```js
await ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS.log()
```

To copy JSON where clipboard access is allowed:

```js
await ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS.copy()
```

For a healthy runtime, the important fields are:

- `isSecureContext: true`
- `crossOriginIsolated: true`
- `sharedArrayBuffer: "function"`
- `atomicsWaitAsync: "function"`
- `opfs.available: true` and `opfs.ok: true`
- `headers.crossOriginEmbedderPolicy: "require-corp"` or `"credentialless"`
- `headers.crossOriginOpenerPolicy: "same-origin"`

If these gates fail, fix HTTPS trust, COOP/COEP headers, service worker
bootstrap, or OPFS availability before debugging workflow code.

## Manual scenarios

Run these on real iOS Safari before considering a Mobile Safari issue fixed:

- Small patch apply with files chosen through the iOS file picker.
- Archive input selection for zip, 7z, or rar.
- Large input or output path that can expose storage quota and memory pressure.
- Save/download output behavior.
- PWA/service-worker reload and update behavior.
- Eruda dev tools enabled from Settings when Web Inspector is not enough.

Record the iOS version, device model, URL, diagnostics JSON, console errors, and
the exact input/output file sizes with every Mobile Safari bug report.
