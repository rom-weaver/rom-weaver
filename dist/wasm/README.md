# rom-weaver WASM JavaScript APIs (Node + Browser)

This folder contains ESM wrappers for running `dist/wasm/rom-weaver-cli.wasm`.

## Files

- `rom-weaver-wasi-api.mjs`: API module
- `rom-weaver-zenfs-api.mjs`: ZenFS-powered Node/Browser wrapper

## Runtime requirements

- Node.js 22+
- WASM artifact from `scripts/build-wasm-cli.sh`

## Optional dependencies for ZenFS wrapper

If you use `rom-weaver-zenfs-api.mjs`, install:

```bash
npm install @zenfs/core @zenfs/dom @bjorn3/browser_wasi_shim
```

- `@zenfs/core`: shared filesystem abstraction
- `@zenfs/dom`: OPFS backend (`WebAccess`)
- `@bjorn3/browser_wasi_shim`: browser WASI preview1 runtime with OPFS sync-handle support

## Quick use

```js
import { createNodeFsRunner, createRomWeaverWasiRunner } from './scripts/wasm/rom-weaver-wasi-api.mjs';

const runner = createRomWeaverWasiRunner();

const help = await runner.run(['--help']);
console.log(help.exitCode);
console.log(help.stdout);

const inspect = await runner.runJson([
  'inspect',
  '/absolute/path/to/file.rom',
]);

console.log(inspect.exitCode);
console.log(inspect.events);

await runner.runJson(
  ['checksum', '/absolute/path/to/file.rom', '--algo', 'crc32'],
  {
    onEvent(event) {
      if (event.status === 'running') {
        console.log(event.percent, event.label);
      }
    },
    onTraceEvent(event) {
      console.log('trace', event);
    },
  },
);

const nodefsRunner = createNodeFsRunner({
  mounts: {
    '/roms': '/Users/you/roms',
    '/out': '/Users/you/out',
  },
});

await nodefsRunner.runJson([
  'checksum',
  '/roms/game.bin',
  '--algo',
  'crc32',
  '--no-extract',
]);
```

## Quick use (ZenFS Node + OPFS Browser)

```js
import {
  createRomWeaverZenFsNode,
  createRomWeaverZenFsBrowser,
} from './scripts/wasm/rom-weaver-zenfs-api.mjs';

const node = await createRomWeaverZenFsNode({
  mounts: {
    '/roms': '/Users/you/roms',
    '/out': '/Users/you/out',
  },
});

const nodeResult = await node.runJson([
  'checksum',
  '/roms/game.bin',
  '--algo',
  'crc32',
  '--no-extract',
]);

const browser = await createRomWeaverZenFsBrowser({
  wasmUrl: '/wasm/rom-weaver-cli.wasm',
  opfsGuestPath: '/opfs',
  runtimeMounts: ['/opfs', '/tmp'],
});

const browserResult = await browser.runJson([
  'checksum',
  '/opfs/game.bin',
  '--algo',
  'crc32',
  '--no-extract',
]);
```

## API

### `createRomWeaverWasiRunner(options)`

Options:

- `wasmPath?: string` - Defaults to `dist/wasm/rom-weaver-cli.wasm` when available.
- `argv0?: string` - Defaults to `rom-weaver`.
- `env?: Record<string, string>` - Extra environment variables for the WASM process.
- `preopens?: Record<string, string>` - Guest to host directory mappings.
- `useDefaultPreopens?: boolean` - Defaults to `true`. Set `false` to fully control mounts.

Default preopens are:

```js
{
  '/': '/',
  '/tmp': tmpdir(),
}
```

`/tmp` should stay preopened because the CLI uses it for temporary files in WASM mode.

### `createNodeFsRunner(options)`

Helper for safer Node host mounts (nodefs-style) without exposing full host `/` by default.

Options:

- `mounts?: Record<string, string>` - Guest path to host path map.
- `mountCwd?: boolean` - Defaults to `true`, mounts current working directory at `/work`.
- `cwdGuestPath?: string` - Defaults to `/work`.
- `mountTmp?: boolean` - Defaults to `true`.
- `tmpGuestPath?: string` - Defaults to `/tmp`.
- `tmpHostPath?: string` - Defaults to `os.tmpdir()`.
- `includeHostRoot?: boolean` - Defaults to `false`. Set `true` to mount `/` -> `/`.
- `preopens?: Record<string, string>` - Additional explicit preopens.
- Also supports all `createRomWeaverWasiRunner` options.

### `buildNodeFsPreopens(options)`

Returns just the computed preopen map from the same options as `createNodeFsRunner`.

### `await runner.run(args, options)`

Runs CLI arguments and returns:

- `exitCode: number`
- `stdout: string`
- `stderr: string`
- `ok: boolean`
- `error?: Error` (set when WASM traps)

### `await runner.runJson(args, options)`

Same as `run`, but automatically prepends `--json` and parses stdout JSONL into:

- `events: any[]`
- `nonJsonLines: string[]`
- `traceEvents: any[]` (parsed from stderr JSON trace lines)
- `traceNonJsonLines: string[]` (stderr lines that were not valid JSON)

Options:

- `onEvent?: (event) => void`
- `onNonJsonLine?: (line) => void`
- `onTraceEvent?: (event) => void`
- `onTraceNonJsonLine?: (line) => void`

`onEvent`/`onNonJsonLine` (stdout) and `onTraceEvent`/`onTraceNonJsonLine` (stderr) are called in output order after execution returns.

### `parseJsonLines(text)`

Utility to parse JSONL output.

### `createRomWeaverZenFsNode(options)`

Creates a Node wrapper that:

- configures ZenFS with `Passthrough` mounts to host paths (nodefs-style),
- provides `fs` from `@zenfs/core`,
- runs rom-weaver via `createRomWeaverWasiRunner`.

Key options:

- `mounts?: Record<string, string>` guest path to host path map
- `mountCwd?: boolean` default `true`
- `cwdGuestPath?: string` default `/work`
- `mountTmp?: boolean` default `true`
- `tmpGuestPath?: string` default `/tmp`
- `tmpHostPath?: string` default `os.tmpdir()`
- `includeHostRoot?: boolean` default `false`
- all `createRomWeaverWasiRunner` options (`wasmPath`, `argv0`, `env`, ...)

### `createRomWeaverZenFsBrowser(options)`

Creates a browser wrapper that:

- configures ZenFS with OPFS via `@zenfs/dom` `WebAccess`,
- runs `rom-weaver` wasm with `@bjorn3/browser_wasi_shim`,
- mounts OPFS directories as preopens and reads/writes files directly (no pre/post copy sync).

Key options:

- `module?: WebAssembly.Module` precompiled module
- `wasmUrl?: string` fallback URL for wasm fetch
- `opfsHandle?: FileSystemDirectoryHandle` defaults to `await navigator.storage.getDirectory()`
- `opfsGuestPath?: string` default `/opfs`
- `tmpGuestPath?: string` default `/tmp`
- `runtimeMounts?: string[]` default `['/opfs', '/tmp']`
- `mountHandles?: Record<string, FileSystemDirectoryHandle>` optional extra guest-path mounts
- `syncAccessMode?: 'read-only' | 'readwrite' | 'readwrite-unsafe'` forwarded to `createSyncAccessHandle`
- `program?: string` default `rom-weaver`
- `env?: Record<string, string>`

Behavior note:
- OPFS-mounted paths do not allow in-memory fallback for path mutations. Create/rename/delete operations return filesystem errors unless the target entries already exist in OPFS.

## Notes

- Node currently marks `node:wasi` as experimental.
- The wrapper captures stdin/stdout/stderr using temporary files and returns the contents.
- Use absolute paths in command arguments unless you intentionally provide guest path mappings in `preopens`.
- Browser zero-copy OPFS mode must run in a secure-context **Dedicated Worker** because `FileSystemSyncAccessHandle` is worker-only.
