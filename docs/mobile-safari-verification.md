# Mobile Safari Verification

RomWeaver's browser runtime needs secure-context APIs, cross-origin isolation,
`SharedArrayBuffer`, `Atomics.waitAsync`, workers, and OPFS. Docker and desktop
emulation can catch some WebKit regressions, but they do not replace real iOS
Safari for file picker, storage quota, memory pressure, download, and PWA
behavior.

## Automation Ladder

Use these checks from cheapest to most faithful:

1. Static compatibility:

   ```bash
   cd packages/rom-weaver-react
   npm run lint:browser-compat
   ```

2. Chromium browser suite, the default local gate:

   ```bash
   cd packages/rom-weaver-react
   npm run test:browser
   ```

3. WebKit smoke check. This uses Playwright's WebKit build, not branded Safari,
   so treat it as an early warning only:

   ```bash
   cd packages/rom-weaver-react
   npm run test:browser:webkit:smoke
   ```

   If Playwright reports a missing WebKit executable, install it once:

   ```bash
   cd packages/rom-weaver-react
   npx playwright install webkit
   ```

4. Optional full WebKit suite:

   ```bash
   cd packages/rom-weaver-react
   npm run test:browser:webkit
   ```

5. Xcode iOS Simulator Safari for repeatable local browser checks on macOS.

6. Real iPhone or iPad Safari for final verification.

Cloud real-device providers are the CI option when a local device farm is not
available. BrowserStack, Sauce Labs, and LambdaTest can run real iOS Safari; use
a secure tunnel for local or staging builds.

## Real Device Setup

Start the HTTPS dev server on the LAN:

```bash
cd packages/rom-weaver-react
npm run dev -- --host 0.0.0.0
```

Open the printed `https://<mac-lan-ip>:5173/` URL on the iPhone or iPad. The
origin must be HTTPS and trusted by iOS; plain LAN HTTP is not enough for this
runtime. If the self-signed certificate blocks testing, use a trusted tunnel or
install and trust the local certificate on the device.

For the full browser-worker matrix on real iOS Safari, open:

```text
https://<mac-lan-ip>:5173/mobile-safari-matrix.html
```

Tap **Run full matrix**. The page runs in the device browser, creates a
temporary OPFS workspace, and exercises:

- container round-trips for zip, zipx, 7z, tar, tar.gz, tar.bz2, tar.xz, gz,
  bz2, xz, zst, cso, chd, and z3ds
- expected unsupported/failure paths for rar, pbp, gcz, wbfs, wia, tgc, nfs,
  rvz, and xiso
- patch create/apply coverage for the patch registry, including direct apply
  fixtures for HDiffPatch, BSP, xdelta, and VCDIFF fixture paths

Use **Copy report** after the run finishes and attach that JSON to Mobile Safari
bug reports.

Enable inspection:

- Mac Safari: Settings > Advanced > Show features for web developers.
- iOS Safari: Settings > Apps > Safari > Advanced > Web Inspector.
- Connect the device to the Mac, then inspect the tab from Safari's Develop
  menu. Xcode Simulator Safari appears in the same Develop menu.

## Runtime Preflight

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

## Manual Scenarios

Run these on real iOS Safari before considering a Mobile Safari issue fixed:

- Small patch apply with files chosen through the iOS file picker.
- Archive input selection for zip, 7z, or rar.
- Large input or output path that can expose storage quota and memory pressure.
- Save/download output behavior.
- PWA/service-worker reload and update behavior.
- Eruda dev tools enabled from Settings when Web Inspector is not enough.

Record the iOS version, device model, URL, diagnostics JSON, console errors, and
the exact input/output file sizes with every Mobile Safari bug report.
