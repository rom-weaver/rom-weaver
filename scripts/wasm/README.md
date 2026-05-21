# rom-weaver WASM JavaScript APIs (Browser)

This folder contains ESM wrappers for browser execution of `rom-weaver-cli.wasm`.

## Files

- `rom-weaver-runtime-utils.mjs`: shared wasm import and JSON/trace parsing helpers
- `rom-weaver-zenfs-api.mjs`: browser OPFS + WASI wrapper

## Runtime requirements

- Secure-context Dedicated Worker runtime
- `rom-weaver-cli.wasm` artifact from `scripts/build-wasm-cli.sh`
- Browser support for OPFS + `FileSystemSyncAccessHandle`

## Optional dependencies for ZenFS wrapper

If you use `rom-weaver-zenfs-api.mjs`, install:

```bash
npm install @zenfs/core @zenfs/dom @bjorn3/browser_wasi_shim
```

## Quick use (Dedicated Worker)

```js
import { createRomWeaverZenFsBrowser } from './scripts/wasm/rom-weaver-zenfs-api.mjs';

const runner = await createRomWeaverZenFsBrowser({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/tmp'],
});

const result = await runner.runJson([
  'checksum',
  '/opfs/game.bin',
  '--algo',
  'crc32',
  '--no-extract',
]);

console.log(result.exitCode, result.ok);
```

## Notes

- This browser wrapper is worker-only. It will throw on the main thread.
- Node.js integration is intentionally omitted; use the native `rom-weaver` CLI directly for Node workflows.
