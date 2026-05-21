import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STRESS_1GB = process.env.ROM_WEAVER_WASM_STRESS_1GB === '1';

const stressLaunchArgs = STRESS_1GB
  ? ['--unlimited-storage']
  : [];

export default defineConfig({
  define: {
    __ROM_WEAVER_WASM_STRESS_1GB__: JSON.stringify(STRESS_1GB),
  },
  server: {
    fs: {
      allow: [REPO_ROOT],
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
        persistentContext: STRESS_1GB,
      }),
      instances: [
        {
          browser: 'chromium',
        },
      ],
      headless: true,
    },
  },
});
