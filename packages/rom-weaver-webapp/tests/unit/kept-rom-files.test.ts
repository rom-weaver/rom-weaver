import { afterEach, expect, it, vi } from "vitest";
import { requestKeptRomFile } from "../../src/storage/browser/kept-rom-files.ts";

afterEach(() => vi.unstubAllGlobals());

const installWorker = () => {
  const terminate = vi.fn();
  const constructed = vi.fn();
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        constructed();
      }
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      terminate = terminate;
      postMessage(message: { requestId: string }) {
        queueMicrotask(() =>
          this.onmessage?.(
            new MessageEvent("message", {
              data: {
                type: "kept-rom-file-result",
                requestId: message.requestId,
                names: [],
              },
            }),
          ),
        );
      }
    },
  );
  return { terminate, constructed };
};

it("cancels the pending proxy request instead of accepting its late reply", async () => {
  const { terminate } = installWorker();
  const controller = new AbortController();
  const pending = requestKeptRomFile({ action: "list" }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(terminate).toHaveBeenCalledOnce();
});

it("does not create a proxy worker for an already cancelled read", async () => {
  const { constructed } = installWorker();
  const controller = new AbortController();
  controller.abort();
  await expect(requestKeptRomFile({ action: "list" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(constructed).not.toHaveBeenCalled();
});
