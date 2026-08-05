import { describe, expect, it, vi } from "vitest";
import {
  registerBrowserSourceCleanup,
  releaseBrowserSource,
  retainBrowserSource,
} from "../../src/storage/browser/browser-source-primitives.ts";

describe("browser source cleanup ownership", () => {
  it("keeps a source alive while the form retains it", async () => {
    const source = {};
    const cleanup = vi.fn();
    const releaseRegisteredSource = registerBrowserSourceCleanup(source, cleanup);

    retainBrowserSource(source);
    await releaseBrowserSource(source);
    expect(cleanup).not.toHaveBeenCalled();

    await releaseRegisteredSource();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
