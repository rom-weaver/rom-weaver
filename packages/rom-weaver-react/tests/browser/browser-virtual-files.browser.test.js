import { expect, test } from "vitest";
import {
  getActiveBrowserVirtualFiles,
  registerBrowserVirtualFile,
} from "../../src/workers/protocol/browser-virtual-files.ts";

test("browser virtual File inputs keep direct transport", () => {
  const source = new File([new Uint8Array([1, 2, 3, 4])], "input.chd", {
    type: "application/octet-stream",
  });
  const unregister = registerBrowserVirtualFile({
    path: "/work/input.chd",
    source,
  });

  try {
    const active = getActiveBrowserVirtualFiles();
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual(
      expect.objectContaining({
        path: "/work/input.chd",
        source,
      }),
    );
    expect(active[0]?.proxy).toBeUndefined();
  } finally {
    unregister();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser virtual Blob inputs keep direct transport", () => {
  const source = new Blob([new Uint8Array([5, 6, 7, 8])], {
    type: "application/octet-stream",
  });
  const unregister = registerBrowserVirtualFile({
    path: "/work/input.bin",
    source,
  });

  try {
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: "/work/input.bin",
        source,
      }),
    ]);
    expect(getActiveBrowserVirtualFiles()[0]?.proxy).toBeUndefined();
  } finally {
    unregister();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
