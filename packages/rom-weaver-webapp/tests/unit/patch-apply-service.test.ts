import { describe, expect, it, vi } from "vitest";
import { resolvePatchTargets } from "../../src/lib/apply/patch-apply-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";

const asset = (id: string, fileName: string): InputAsset =>
  ({
    file: { fileName, fileSize: 1 },
    fileName,
    id,
    kind: "rom",
    patchable: true,
    size: 1,
  }) as unknown as InputAsset;

const patch = (matches: string[]) => ({
  apply: vi.fn(),
  validateSourceAsync: vi.fn(async (file: { fileName: string }) => matches.includes(file.fileName)),
});

describe("resolvePatchTargets checksum auto-targeting", () => {
  it("selects the only matching patchable input", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["second.bin"])], undefined)).resolves.toEqual([second]);
  });

  it("rejects an ambiguous checksum match", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch(["first.bin", "second.bin"])], undefined)).rejects.toThrow(
      "matches multiple inputs",
    );
  });

  it("rejects when no input matches", async () => {
    const first = asset("first", "first.bin");
    const second = asset("second", "second.bin");
    await expect(resolvePatchTargets([first, second], [patch([])], undefined)).rejects.toThrow(
      "does not match exactly one input",
    );
  });
});
