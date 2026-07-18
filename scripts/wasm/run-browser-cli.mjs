#!/usr/bin/env node

import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const WASM_PACKAGE_DIR = resolve(REPO_ROOT, 'packages/rom-weaver-webapp');
const DEFAULT_WASM_MODULE = resolve(WASM_PACKAGE_DIR, 'src/wasm/rom-weaver-app.wasm');
const WORK_GUEST_PATH = '/work';
const STAGE_INPUT_CHUNK_BYTES = 2 * 1024 * 1024;

const SUPPORTED_COMMANDS = new Set(['compress', 'extract', 'checksum', 'patch']);

function parseArgs(argv) {
  let wasmModule = DEFAULT_WASM_MODULE;
  let stdinJson = false;
  let commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      commandArgs = argv.slice(index + 1);
      break;
    }
    if (arg === '--wasm-module') {
      const next = argv[index + 1];
      if (!next) throw new Error('--wasm-module requires a value');
      wasmModule = resolve(REPO_ROOT, next);
      index += 1;
      continue;
    }
    if (arg === '--stdin-json') {
      stdinJson = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!stdinJson && commandArgs.length === 0) {
    throw new Error('missing command args; pass rom-weaver command args after `--`');
  }

  return {
    wasmModule: resolve(wasmModule),
    stdinJson,
    commandArgs,
  };
}

function resolveHostPath(rawPath) {
  if (isAbsolute(rawPath)) return rawPath;
  return resolve(process.cwd(), rawPath);
}

function normalizePathToken(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function isGuestPath(rawPath) {
  const normalized = normalizePathToken(String(rawPath));
  return normalized === WORK_GUEST_PATH || normalized.startsWith(`${WORK_GUEST_PATH}/`);
}

function locateCommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] ?? '').trim().toLowerCase();
    if (token === 'patch') {
      const subcommand = String(args[index + 1] ?? '').trim().toLowerCase();
      if (subcommand === 'apply' || subcommand === 'create' || subcommand === 'validate') {
        return { command: 'patch', index, subcommand };
      }
      throw new Error(`unsupported patch subcommand: ${subcommand || '(missing)'}`);
    }
    if (SUPPORTED_COMMANDS.has(token)) {
      return { command: token, index, subcommand: '' };
    }
  }
  throw new Error(`unable to locate supported command in args: ${args.join(' ')}`);
}

function createCommandRequest(command, subcommand) {
  if (command === 'patch') {
    return { type: 'patch', args: { type: subcommand, args: {} } };
  }
  return { type: command, args: {} };
}

function readFlagValue(args, flag, commandIndex) {
  for (let index = commandIndex + 1; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value) {
      throw new Error(`missing value for ${flag}`);
    }
    return { index: index + 1, value: String(value) };
  }
  return null;
}

function collectPathBindings(commandArgs) {
  const resolvedArgs = [...commandArgs];
  const { command, index: commandIndex, subcommand } = locateCommand(commandArgs);
  const inputs = [];
  const outputs = [];

  const addPositionalInput = (positionFromCommand) => {
    const argIndex = commandIndex + positionFromCommand;
    const value = resolvedArgs[argIndex];
    if (!value) throw new Error(`missing positional path at index ${argIndex}`);
    if (isGuestPath(value)) {
      resolvedArgs[argIndex] = normalizePathToken(String(value));
      return;
    }
    inputs.push({
      argIndex,
      hostPath: resolveHostPath(String(value)),
      hintName: basename(String(value)),
    });
  };

  const addFlagInput = (flag) => {
    const found = readFlagValue(resolvedArgs, flag, commandIndex);
    if (!found) throw new Error(`missing required ${flag}`);
    if (isGuestPath(found.value)) {
      resolvedArgs[found.index] = normalizePathToken(found.value);
      return;
    }
    inputs.push({
      argIndex: found.index,
      hostPath: resolveHostPath(found.value),
      hintName: basename(found.value),
    });
  };

  const addFlagOutputFile = (flag) => {
    const found = readFlagValue(resolvedArgs, flag, commandIndex);
    if (!found) throw new Error(`missing required ${flag}`);
    if (isGuestPath(found.value)) {
      resolvedArgs[found.index] = normalizePathToken(found.value);
      return;
    }
    outputs.push({
      argIndex: found.index,
      hostPath: resolveHostPath(found.value),
      hostType: 'file',
      hintName: basename(found.value),
    });
  };

  const addFlagOutputDir = (flag) => {
    const found = readFlagValue(resolvedArgs, flag, commandIndex);
    if (!found) throw new Error(`missing required ${flag}`);
    if (isGuestPath(found.value)) {
      resolvedArgs[found.index] = normalizePathToken(found.value);
      return;
    }
    outputs.push({
      argIndex: found.index,
      hostPath: resolveHostPath(found.value),
      hostType: 'dir',
      hintName: basename(found.value || 'out'),
    });
  };

  switch (command === 'patch' ? `patch-${subcommand}` : command) {
    case 'compress':
      addPositionalInput(1);
      addFlagOutputFile('--output');
      break;
    case 'extract':
      addPositionalInput(1);
      addFlagOutputDir('--out-dir');
      break;
    case 'checksum':
      addPositionalInput(1);
      break;
    case 'patch-create':
      addFlagInput('--original');
      addFlagInput('--modified');
      addFlagOutputFile('--output');
      break;
    case 'patch-apply':
      addFlagInput('--input');
      addFlagInput('--patch');
      addFlagOutputFile('--output');
      break;
    case 'patch-validate':
      addFlagInput('--input');
      addFlagInput('--patch');
      break;
    default:
      throw new Error(`unsupported command: ${command}`);
  }

  const pathIds = new Set();
  for (const rawToken of resolvedArgs) {
    if (!isGuestPath(rawToken)) continue;
    pathIds.add(normalizePathToken(String(rawToken)));
  }
  for (let index = 0; index < inputs.length; index += 1) {
    const entry = inputs[index];
    const guestPath = `${WORK_GUEST_PATH}/${index}-${sanitizeName(entry.hintName)}`;
    pathIds.add(guestPath);
    resolvedArgs[entry.argIndex] = guestPath;
    entry.guestPath = guestPath;
  }
  for (let index = 0; index < outputs.length; index += 1) {
    const entry = outputs[index];
    const prefix = entry.hostType === 'dir' ? 'out-dir' : 'output';
    const fallback = entry.hostType === 'dir' ? `dir-${index}` : `file-${index}.bin`;
    const label = sanitizeName(entry.hintName) || fallback;
    const guestPath = `${WORK_GUEST_PATH}/${prefix}-${index}-${label}`;
    if (pathIds.has(guestPath)) {
      throw new Error(`guest path collision for ${guestPath}`);
    }
    pathIds.add(guestPath);
    resolvedArgs[entry.argIndex] = guestPath;
    entry.guestPath = guestPath;
  }

  return {
    command,
    subcommand,
    mappedArgs: resolvedArgs,
    inputs,
    outputs,
  };
}

function commandArgsToRunRequest(args) {
  const { command, index: commandIndex, subcommand } = locateCommand(args);
  const parsed = parseCommandTokens(args, commandIndex);
  const output = {};
  if (parsed.flags.has('trace')) output.trace = true;
  if (parsed.flags.has('dep-trace')) output.dep_trace = true;
  if (parsed.flags.has('progress')) output.progress = true;
  if (parsed.flags.has('no-progress')) output.progress = false;

  const commandRequest = createCommandRequest(command, subcommand);
  const commandArgs = command === 'patch' ? commandRequest.args.args : commandRequest.args;
  switch (command === 'patch' ? `patch-${subcommand}` : command) {
    case 'compress':
      Object.assign(commandArgs, {
        input: parsed.positionals,
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionalValue(parsed, 'format') ? { format: readOptionalValue(parsed, 'format') } : {}),
        ...(readOptionValues(parsed, 'codec').length ? { codec: readOptionValues(parsed, 'codec') } : {}),
        ...(readOptionalValue(parsed, 'level') ? { level: readOptionalValue(parsed, 'level') } : {}),
      });
      break;
    case 'extract':
      Object.assign(commandArgs, {
        source: requirePositional(parsed, 0, 'extract source'),
        out_dir: requireOptionValue(parsed, 'out-dir'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(readOptionValues(parsed, 'checksum').length ? { checksum: readOptionValues(parsed, 'checksum') } : {}),
        ...(parsed.flags.has('split-bin') ? { split_bin: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-nested-extract') ? { no_nested_extract: true } : {}),
        ...(parsed.flags.has('no-overwrite') ? { no_overwrite: true } : {}),
      });
      break;
    case 'checksum':
      Object.assign(commandArgs, {
        source: requirePositional(parsed, 0, 'checksum source'),
        algo: readOptionValues(parsed, 'algo'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('no-trim-fix') ? { no_trim_fix: true } : {}),
        ...(readOptionalNumber(parsed, 'start') !== null ? { start: readOptionalNumber(parsed, 'start') } : {}),
        ...(readOptionalNumber(parsed, 'length') !== null ? { length: readOptionalNumber(parsed, 'length') } : {}),
      });
      break;
    case 'patch-create':
      Object.assign(commandArgs, {
        original: requireOptionValue(parsed, 'original'),
        modified: requireOptionValue(parsed, 'modified'),
        format: requireOptionValue(parsed, 'format'),
        output: requireOptionValue(parsed, 'output'),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
        ...(readOptionalValue(parsed, 'xdelta-secondary') ? { xdelta_secondary: readOptionalValue(parsed, 'xdelta-secondary') } : {}),
      });
      break;
    case 'patch-apply':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-compress') ? { no_compress: true } : {}),
        ...(readOptionalValue(parsed, 'compress-format') ? { compress_format: readOptionalValue(parsed, 'compress-format') } : {}),
        ...(readOptionValues(parsed, 'compress-codec').length ? { compress_codec: readOptionValues(parsed, 'compress-codec') } : {}),
        ...(readOptionalValue(parsed, 'compress-level') ? { compress_level: readOptionalValue(parsed, 'compress-level') } : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length ? { checksum_cache: readOptionValues(parsed, 'checksum-cache') } : {}),
        ...(readOptionValues(parsed, 'validate-with-checksum').length
          ? { validate_with_checksums: readOptionValues(parsed, 'validate-with-checksum') }
          : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('add-header') ? { add_header: true } : {}),
        ...(parsed.flags.has('repair-checksum') ? { repair_checksum: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    case 'patch-validate':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length ? { checksum_cache: readOptionValues(parsed, 'checksum-cache') } : {}),
        ...(readOptionValues(parsed, 'validate-with-checksum').length
          ? { validate_with_checksums: readOptionValues(parsed, 'validate-with-checksum') }
          : {}),
        ...(readOptionalNumber(parsed, 'validate-with-size') !== null
          ? { validate_with_size: readOptionalNumber(parsed, 'validate-with-size') }
          : {}),
        ...(readOptionalNumber(parsed, 'validate-with-min-size') !== null
          ? { validate_with_min_size: readOptionalNumber(parsed, 'validate-with-min-size') }
          : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    default:
      throw new Error(`unsupported command: ${command === 'patch' ? `patch ${subcommand}` : command}`);
  }

  const threads = readOptionalThreadBudget(parsed);
  if (threads !== null) commandArgs.threads = threads;

  return Object.keys(output).length > 0
    ? { command: commandRequest, output }
    : commandRequest;
}

function parseCommandTokens(args, commandIndex) {
  const flags = new Set();
  const options = new Map();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) {
      if (String(args[index] ?? '').trim().toLowerCase() === 'patch') index += 1;
      continue;
    }
    const raw = String(args[index] ?? '');
    if (!raw.startsWith('--')) {
      if (index > commandIndex) positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    let value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : null;
    if (
      value === null
      && index > commandIndex
      && index + 1 < args.length
      && !String(args[index + 1] ?? '').startsWith('--')
    ) {
      value = String(args[index + 1]);
      index += 1;
    }
    if (value === null) {
      flags.add(name);
      continue;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { flags, options, positionals };
}

function readOptionValues(parsed, name) {
  return parsed.options.get(name) ?? [];
}

function readOptionalValue(parsed, name) {
  return readOptionValues(parsed, name)[0] ?? null;
}

function readOptionalNumber(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (value === null) return null;
  const parsedNumber = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedNumber) || parsedNumber < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsedNumber;
}

function readOptionalThreadBudget(parsed) {
  const value = readOptionalValue(parsed, 'threads');
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  const parsedNumber = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new Error('threads must be auto or a positive integer');
  }
  return parsedNumber;
}

function requireOptionValue(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function requirePositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function sanitizeName(name) {
  const source = String(name || 'path').trim();
  const replaced = source.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return replaced.length > 0 ? replaced : 'path';
}

function ensureInRepo(path) {
  const rel = relative(REPO_ROOT, path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')) {
    return;
  }
  throw new Error(`path must stay within repo root for browser benchmark runner: ${path}`);
}

async function loadViteApi() {
  const viteEntry = pathToFileURL(resolve(WASM_PACKAGE_DIR, 'node_modules/vite/dist/node/index.js')).href;
  const module = await import(viteEntry);
  if (typeof module.createServer !== 'function') {
    throw new Error('vite createServer export is unavailable');
  }
  return module;
}

async function loadPlaywrightApi() {
  const playwrightEntry = pathToFileURL(resolve(WASM_PACKAGE_DIR, 'node_modules/playwright/index.mjs')).href;
  const module = await import(playwrightEntry);
  if (!module.chromium) {
    throw new Error('playwright chromium export is unavailable');
  }
  return module;
}

function browserWorkerModuleUrl(baseUrl) {
  return new URL('/packages/rom-weaver-webapp/src/wasm/workers/browser-worker-client.ts', baseUrl).toString();
}

function wasmModuleUrl(baseUrl, wasmModulePath) {
  const rel = relative(REPO_ROOT, wasmModulePath).replace(/\\/g, '/');
  if (rel.startsWith('..')) {
    throw new Error(`wasm module must live within repo root: ${wasmModulePath}`);
  }
  return new URL(`/${rel}`, baseUrl).toString();
}

async function startViteServer() {
  const vite = await loadViteApi();
  const benchShellPath = '/__rwbench__/index.html';
  const benchShellHtml = '<!doctype html><html><head><meta charset="utf-8"><title>rw-bench</title></head><body>rw-bench</body></html>';
  const server = await vite.createServer({
    root: REPO_ROOT,
    clearScreen: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'rw-bench-shell',
        configureServer(devServer) {
          devServer.middlewares.use((req, res, next) => {
            if (req.url !== benchShellPath) {
              next();
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.end(benchShellHtml);
          });
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: {
        allow: [REPO_ROOT],
      },
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : server.config.server.port;
  const origin = `http://127.0.0.1:${port}`;
  return { server, origin, benchShellPath };
}

async function bootBrowserHarness({ origin, wasmUrl, benchShellPath }) {
  const playwright = await loadPlaywrightApi();
  const browser = await playwright.chromium.launch({
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}${benchShellPath}`, { waitUntil: 'domcontentloaded' });

  const workerUrl = browserWorkerModuleUrl(origin);
  const init = await page.evaluate(
    async ({ workerUrl: resolvedWorkerUrl, wasmUrl: resolvedWasmUrl, workGuestPath }) => {
      const module = await import(resolvedWorkerUrl);
      const worker = module.createBrowserWorkerClient();
      const root = await navigator.storage.getDirectory();
      const fixtureName = `rw-browser-bench-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const fixtureHandle = await root.getDirectoryHandle(fixtureName, { create: true });

      function splitGuestPath(rawPath) {
        const normalized = String(rawPath).replace(/\\/g, '/');
        if (!normalized.startsWith(workGuestPath)) {
          throw new Error(`guest path is outside work root: ${normalized}`);
        }
        const suffix = normalized.slice(workGuestPath.length).replace(/^\/+/, '');
        return suffix.length === 0 ? [] : suffix.split('/').filter(Boolean);
      }

      async function getParentDirectoryForPath(rawPath, create = true) {
        const parts = splitGuestPath(rawPath);
        let dir = fixtureHandle;
        for (let index = 0; index < parts.length - 1; index += 1) {
          dir = await dir.getDirectoryHandle(parts[index], { create });
        }
        return { dir, name: parts[parts.length - 1] ?? '' };
      }

      async function getDirectoryForPath(rawPath, create = true) {
        const parts = splitGuestPath(rawPath);
        let dir = fixtureHandle;
        for (const part of parts) {
          dir = await dir.getDirectoryHandle(part, { create });
        }
        return dir;
      }

      async function listGuestFiles(rawDirectory) {
        const directoryHandle = await getDirectoryForPath(rawDirectory, false);
        const normalized = String(rawDirectory).replace(/\\/g, '/').replace(/\/+$/, '');
        const queue = [{ prefix: normalized, dir: directoryHandle }];
        const files = [];
        while (queue.length > 0) {
          const current = queue.shift();
          for await (const [name, handle] of current.dir.entries()) {
            const nextPath = `${current.prefix}/${name}`.replace(/\/+/g, '/');
            if (handle.kind === 'file') {
              files.push(nextPath);
            } else if (handle.kind === 'directory') {
              queue.push({ prefix: nextPath, dir: handle });
            }
          }
        }
        files.sort();
        return files;
      }

      const ready = await worker.init({
        wasmUrl: resolvedWasmUrl,
        opfsHandle: fixtureHandle,
        workGuestPath,
        runtimeMounts: [workGuestPath],
        defaultThreads: 1,
      });

      globalThis.__rwBrowserBench = {
        worker,
        workGuestPath,
        async writeGuestFile(path, bytes) {
          const { dir, name } = await getParentDirectoryForPath(path, true);
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(bytes);
          await writable.close();
        },
        async writeGuestFileChunk(path, bytes, offset, totalBytes) {
          const { dir, name } = await getParentDirectoryForPath(path, true);
          const fileHandle = await dir.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable({ keepExistingData: offset > 0 });
          await writable.write({
            type: 'write',
            position: offset,
            data: bytes,
          });
          if (offset + bytes.length >= totalBytes) {
            await writable.truncate(totalBytes);
          }
          await writable.close();
        },
        async readGuestFile(path) {
          const { dir, name } = await getParentDirectoryForPath(path, false);
          const fileHandle = await dir.getFileHandle(name, { create: false });
          const file = await fileHandle.getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          return bytes;
        },
        async listGuestFiles(directoryPath) {
          return listGuestFiles(directoryPath);
        },
        async run(request) {
          const result = await worker.runJson(request);
          const terminal = Array.isArray(result.events) && result.events.length > 0
            ? result.events[result.events.length - 1]
            : null;
          return {
            ok: result.ok,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            terminal,
            error: result.error
              ? {
                name: result.error.name ?? 'Error',
                message: result.error.message ?? String(result.error),
              }
              : null,
          };
        },
        terminate() {
          worker.terminate();
        },
      };

      return {
        mode: ready.mode,
        threaded: ready.threaded,
        wasmUrl: ready.wasmUrl,
      };
    },
    {
      workerUrl,
      wasmUrl,
      workGuestPath: WORK_GUEST_PATH,
    },
  );

  return { browser, context, page, init };
}

async function stageInputs(page, inputMappings) {
  for (const mapping of inputMappings) {
    const totalBytes = statSync(mapping.hostPath).size;
    const fd = openSync(mapping.hostPath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(STAGE_INPUT_CHUNK_BYTES);
      let offset = 0;
      while (offset < totalBytes) {
        const chunkLength = Math.min(buffer.byteLength, totalBytes - offset);
        const bytesRead = readSync(fd, buffer, 0, chunkLength, offset);
        if (bytesRead <= 0) break;
        const bytesValue = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        await page.evaluate(
          async ({ guestPath, offsetValue, totalValue, chunk }) => {
            const harness = globalThis.__rwBrowserBench;
            if (!harness) throw new Error('browser benchmark harness is not initialized');
            await harness.writeGuestFileChunk(guestPath, chunk, offsetValue, totalValue);
          },
          {
            guestPath: mapping.guestPath,
            offsetValue: offset,
            totalValue: totalBytes,
            chunk: bytesValue,
          },
        );
        offset += bytesRead;
      }
    } finally {
      closeSync(fd);
    }
  }
}

function ensureHostParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function removePath(path) {
  rmSync(path, { recursive: true, force: true });
}

async function materializeOutputs(page, outputMappings) {
  for (const mapping of outputMappings) {
    if (mapping.hostType === 'file') {
      const bytes = await page.evaluate(
        async ({ guestPath }) => {
          const harness = globalThis.__rwBrowserBench;
          if (!harness) throw new Error('browser benchmark harness is not initialized');
          return harness.readGuestFile(guestPath);
        },
        { guestPath: mapping.guestPath },
      );
      ensureHostParent(mapping.hostPath);
      writeFileSync(mapping.hostPath, Buffer.from(bytes));
      continue;
    }

    const guestFiles = await page.evaluate(
      async ({ guestDirectory }) => {
        const harness = globalThis.__rwBrowserBench;
        if (!harness) throw new Error('browser benchmark harness is not initialized');
        return harness.listGuestFiles(guestDirectory);
      },
      { guestDirectory: mapping.guestPath },
    );

    removePath(mapping.hostPath);
    mkdirSync(mapping.hostPath, { recursive: true });

    for (const guestFilePath of guestFiles) {
      const bytes = await page.evaluate(
        async ({ guestPath }) => {
          const harness = globalThis.__rwBrowserBench;
          if (!harness) throw new Error('browser benchmark harness is not initialized');
          return harness.readGuestFile(guestPath);
        },
        { guestPath: guestFilePath },
      );
      const relativePath = guestFilePath.slice(mapping.guestPath.length).replace(/^\/+/, '');
      const hostTargetPath = resolve(mapping.hostPath, relativePath || basename(guestFilePath));
      ensureHostParent(hostTargetPath);
      writeFileSync(hostTargetPath, Buffer.from(bytes));
    }
  }
}

async function runSingleCommandInBrowser({
  mappedArgs,
  wasmModule,
  inputMappings,
  outputMappings,
}) {
  ensureInRepo(wasmModule);

  const tmpBase = mkdtempSync(resolve(tmpdir(), 'rw-browser-cli-'));
  let viteServer = null;
  let browserHarness = null;

  try {
    const { server, origin, benchShellPath } = await startViteServer();
    viteServer = server;
    const wasmUrl = wasmModuleUrl(origin, wasmModule);

    const booted = await bootBrowserHarness({ origin, wasmUrl, benchShellPath });
    browserHarness = booted;

    await stageInputs(booted.page, inputMappings);
    const request = commandArgsToRunRequest(mappedArgs);
    const result = await booted.page.evaluate(
      async ({ request }) => {
        const harness = globalThis.__rwBrowserBench;
        if (!harness) throw new Error('browser benchmark harness is not initialized');
        return harness.run(request);
      },
      { request },
    );

    if (result.ok && Number(result.exitCode) === 0) {
      await materializeOutputs(booted.page, outputMappings);
      return { ok: true, exitCode: 0 };
    }

    const errorTail = [
      `browser wasm command failed (${result.exitCode})`,
      result.error?.message ? `error=${result.error.message}` : null,
      result.terminal?.label ? `label=${result.terminal.label}` : null,
      result.stderr ? `stderr=${result.stderr.trim().split('\n').slice(-1)[0]}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ok: false,
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
      message: errorTail || 'browser wasm command failed',
    };
  } finally {
    if (browserHarness?.page) {
      try {
        await browserHarness.page.evaluate(async () => {
          if (globalThis.__rwBrowserBench) {
            globalThis.__rwBrowserBench.terminate();
          }
        });
      } catch {
        // best-effort cleanup only
      }
    }
    if (browserHarness?.browser) {
      try {
        await browserHarness.browser.close();
      } catch {
        // best-effort cleanup only
      }
    }
    if (viteServer) {
      try {
        await viteServer.close();
      } catch {
        // best-effort cleanup only
      }
    }
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

async function runJsonSession({ wasmModule }) {
  ensureInRepo(wasmModule);

  const tmpBase = mkdtempSync(resolve(tmpdir(), 'rw-browser-cli-'));
  let viteServer = null;
  let browserHarness = null;

  try {
    const { server, origin, benchShellPath } = await startViteServer();
    viteServer = server;
    const wasmUrl = wasmModuleUrl(origin, wasmModule);
    const booted = await bootBrowserHarness({ origin, wasmUrl, benchShellPath });
    browserHarness = booted;
    process.stdout.write(JSON.stringify({ ready: true }) + '\n');

    const rl = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });

    for await (const line of rl) {
      const raw = line.trim();
      if (raw.length === 0) continue;

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            exitCode: 2,
            elapsedS: 0,
            message: 'invalid json payload',
          }) + '\n'
        );
        continue;
      }

      const args = Array.isArray(payload?.args) ? payload.args.map((value) => String(value)) : null;
      if (!args || args.length === 0) {
        process.stdout.write(
          JSON.stringify({
            ok: false,
            exitCode: 2,
            elapsedS: 0,
            message: 'payload.args must be a non-empty array',
          }) + '\n'
        );
        continue;
      }

      const started = Date.now();
      try {
        const { mappedArgs, inputs, outputs } = collectPathBindings(args);
        const request = commandArgsToRunRequest(mappedArgs);
        await stageInputs(booted.page, inputs);
        const result = await booted.page.evaluate(
          async ({ request: mappedRequest }) => {
            const harness = globalThis.__rwBrowserBench;
            if (!harness) throw new Error('browser benchmark harness is not initialized');
            return harness.run(mappedRequest);
          },
          { request },
        );
        const elapsedS = (Date.now() - started) / 1000;
        if (result.ok && Number(result.exitCode) === 0) {
          await materializeOutputs(booted.page, outputs);
          process.stdout.write(
            JSON.stringify({
              ok: true,
              exitCode: 0,
              elapsedS,
              message: '',
            }) + '\n'
          );
        } else {
          const errorTail = [
            `browser wasm command failed (${result.exitCode})`,
            result.error?.message ? `error=${result.error.message}` : null,
            result.terminal?.label ? `label=${result.terminal.label}` : null,
            result.stderr ? `stderr=${result.stderr.trim().split('\n').slice(-1)[0]}` : null,
          ]
            .filter(Boolean)
            .join(' ');
          process.stdout.write(
            JSON.stringify({
              ok: false,
              exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 1,
              elapsedS,
              message: errorTail || 'browser wasm command failed',
            }) + '\n'
          );
        }
      } catch (error) {
        const elapsedS = (Date.now() - started) / 1000;
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        process.stdout.write(
          JSON.stringify({
            ok: false,
            exitCode: 1,
            elapsedS,
            message,
          }) + '\n'
        );
      }
    }
  } finally {
    if (browserHarness?.page) {
      try {
        await browserHarness.page.evaluate(async () => {
          if (globalThis.__rwBrowserBench) {
            globalThis.__rwBrowserBench.terminate();
          }
        });
      } catch {
        // best-effort cleanup only
      }
    }
    if (browserHarness?.browser) {
      try {
        await browserHarness.browser.close();
      } catch {
        // best-effort cleanup only
      }
    }
    if (viteServer) {
      try {
        await viteServer.close();
      } catch {
        // best-effort cleanup only
      }
    }
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

async function main() {
  const { wasmModule, stdinJson, commandArgs } = parseArgs(process.argv.slice(2));
  if (stdinJson) {
    await runJsonSession({ wasmModule });
    return;
  }
  const { mappedArgs, inputs, outputs } = collectPathBindings(commandArgs);
  const result = await runSingleCommandInBrowser({
    mappedArgs,
    wasmModule,
    inputMappings: inputs,
    outputMappings: outputs,
  });
  if (!result.ok) {
    throw new Error(result.message ?? 'browser wasm command failed');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
