import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// In a git worktree, node_modules entries are symlinks into the main checkout
// (scripts/setup-worktree.sh); vite resolves their real paths, which fall
// outside the worktree's REPO_ROOT and get 403'd unless also allowed.
const GIT_COMMON_ROOT = (() => {
  try {
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return dirname(commonDir);
  } catch {
    return REPO_ROOT;
  }
})();
const STRESS_1GB = process.env.ROM_WEAVER_WASM_STRESS_1GB === '1';
const BENCH_OUTPUT_JSON = process.env.ROM_WEAVER_WASM_BENCH_OUTPUT_JSON;
const BENCH_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('ROM_WEAVER_WASM_')),
);
const BENCH_MODE = process.env.ROM_WEAVER_WASM_BENCH === '1'
  || Object.keys(BENCH_ENV).some((key) => key.startsWith('ROM_WEAVER_WASM_BENCH_'));
const BENCH_PROFILE_DIR = fileURLToPath(new URL('../../target/browser-bench-profile', import.meta.url));
const PERSISTENT_CONTEXT = STRESS_1GB ? true : (BENCH_MODE ? BENCH_PROFILE_DIR : false);

const stressLaunchArgs = (STRESS_1GB || BENCH_MODE)
  ? ['--unlimited-storage']
  : [];

export default defineConfig({
  envPrefix: ['VITE_', 'ROM_WEAVER_WASM_'],
  define: {
    __ROM_WEAVER_WASM_STRESS_1GB__: JSON.stringify(STRESS_1GB),
    __ROM_WEAVER_WASM_BENCH_ENV__: JSON.stringify(BENCH_ENV),
  },
  server: {
    fs: {
      allow: [...new Set([REPO_ROOT, GIT_COMMON_ROOT])],
    },
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  test: {
    include: ['tests/*.test.mjs'],
    testTimeout: 180_000,
    isolate: true,
    browser: {
      enabled: true,
      provider: playwright({
        launchOptions: {
          args: stressLaunchArgs,
        },
        persistentContext: PERSISTENT_CONTEXT,
      }),
      instances: [
        {
          browser: 'chromium',
        },
      ],
      fileParallelism: !BENCH_MODE,
      headless: true,
    },
  },
  benchmark: {
    include: ['tests/*.bench.mjs'],
    outputFile: BENCH_OUTPUT_JSON || undefined,
  },
});
