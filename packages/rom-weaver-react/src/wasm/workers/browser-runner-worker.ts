import type { RomWeaverBrowserOpfsRunner } from "../rom-weaver-browser-opfs-api.ts";
import { createRomWeaverBrowserOpfs } from "../rom-weaver-browser-opfs-api.ts";
import { createRunnerWorkerMessageQueue } from "./runner-worker-core.ts";
import type { RomWeaverWorkerRequest } from "./worker-protocol.ts";

const workerMessages = createRunnerWorkerMessageQueue({
  async initRunner({ mode, options }) {
    const resolvedMode = mode ?? "browser-opfs";
    if (resolvedMode !== "browser-opfs") {
      throw new Error(`unsupported browser worker mode: ${resolvedMode}. Supported mode is: browser-opfs.`);
    }

    return {
      mode: "browser-opfs" as const,
      runner: (await createRomWeaverBrowserOpfs(options)) as RomWeaverBrowserOpfsRunner,
    };
  },
  postMessage(message) {
    self.postMessage(message);
  },
});

self.addEventListener("message", (event) => {
  workerMessages.enqueue(event.data as RomWeaverWorkerRequest);
});

self.addEventListener("messageerror", () => {
  self.postMessage({
    error: {
      context: { stage: "worker.messageerror" },
      kind: "worker",
      message: "browser runner worker could not deserialize a posted message",
      name: "DataCloneError",
    },
    requestId: null,
    type: "error",
  });
});
