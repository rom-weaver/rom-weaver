import { createRomWeaverBrowserOpfs } from '../rom-weaver-browser-opfs-api.ts';
import { createRunnerWorkerMessageQueue } from './runner-worker-core.ts';
import type { RomWeaverBrowserOpfsRunner } from '../rom-weaver-browser-opfs-api.ts';
import type { RomWeaverWorkerRequest } from './worker-protocol.ts';

const workerMessages = createRunnerWorkerMessageQueue({
  postMessage(message) {
    self.postMessage(message);
  },
  async initRunner({ mode, options }) {
    const resolvedMode = mode ?? 'browser-opfs';
    if (resolvedMode !== 'browser-opfs') {
      throw new Error(
        `unsupported browser worker mode: ${resolvedMode}. `
          + 'Supported mode is: browser-opfs.',
      );
    }

    return {
      runner: await createRomWeaverBrowserOpfs(options) as RomWeaverBrowserOpfsRunner,
      mode: 'browser-opfs' as const,
    };
  },
});

self.addEventListener('message', (event) => {
  workerMessages.enqueue(event.data as RomWeaverWorkerRequest);
});

self.addEventListener('messageerror', () => {
  self.postMessage({
    type: 'error',
    requestId: null,
    error: {
      name: 'DataCloneError',
      message: 'browser runner worker could not deserialize a posted message',
      kind: 'worker',
      context: { stage: 'worker.messageerror' },
    },
  });
});
