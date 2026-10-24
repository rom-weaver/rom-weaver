import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { prepareInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { createPatchFile } from "../../src/lib/input/binary-service.ts";

const decompression = vi.hoisted(() => ({ resolveCompressedInputAssets: vi.fn() }));

vi.mock("../../src/lib/input/input-decompression.ts", async () => ({
  ...(await vi.importActual<typeof import("../../src/lib/input/input-decompression.ts")>(
    "../../src/lib/input/input-decompression.ts",
  )),
  resolveCompressedInputAssets: decompression.resolveCompressedInputAssets,
}));

const runtime = { name: "browser" as const, sidecars: {} };

// Rust ingest attaches the create mode native `chd` auto-inference picks for the file's bytes as
// `romType.chdCreateMode`; the webapp only maps it to the UI-only DVD codec hint.
describe("prepareInputAssets CHD codec hint", () => {
  beforeEach(() => decompression.resolveCompressedInputAssets.mockReset());

  it.each([
    ["dvd", "disc.iso", "dvd"],
    ["hd", "hybrid.bin", "dvd"],
    ["cd", "disc.iso", undefined],
    ["raw", "blob.bin", undefined],
  ])("maps the Rust verdict %s for %s to the %s codec hint", async (verdict, fileName, hint) => {
    const file = Object.assign(await createPatchFile(new File([new Uint8Array(2048)], fileName), fileName), {
      romType: { chdCreateMode: verdict },
    });
    decompression.resolveCompressedInputAssets.mockResolvedValue([
      { file, fileName, id: "a", kind: "rom", patchable: true, size: 2048 } satisfies InputAsset,
    ]);
    const onProgress = vi.fn();
    const assets = await prepareInputAssets(
      new File([new Uint8Array(2048)], fileName),
      { input: { containerInputsEnabled: false }, onProgress },
      0,
      runtime,
    );
    expect(assets[0]?.chdCodecMode).toBe(hint);
    expect(onProgress.mock.calls.some(([event]) => event.details?.chdCodecMode === "dvd")).toBe(hint === "dvd");
  });

  it("keeps an identified source's metadata mode over the engine verdict", async () => {
    const file = Object.assign(await createPatchFile(new File([new Uint8Array(2048)], "disc.iso"), "disc.iso"), {
      romType: { chdCreateMode: "dvd" },
    });
    file.metadata = { mode: "cd" };
    decompression.resolveCompressedInputAssets.mockResolvedValue([
      { file, fileName: "disc.iso", id: "a", kind: "rom", patchable: true, size: 2048 } satisfies InputAsset,
    ]);
    const assets = await prepareInputAssets(
      new File([new Uint8Array(2048)], "disc.iso"),
      { input: { containerInputsEnabled: false } },
      0,
      runtime,
    );
    expect(assets[0]?.chdCodecMode).toBeUndefined();
  });
});
