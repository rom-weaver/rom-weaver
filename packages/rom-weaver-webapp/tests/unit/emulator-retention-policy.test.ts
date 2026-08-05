import { describe, expect, it } from "vitest";
import { shouldRetainEmulatorOutput } from "../../src/public/react/emulator-retention-policy.ts";

const MAX_BYTES = 128 * 1024 * 1024;

describe("emulator retention policy", () => {
  it("retains supported ROMs at or below the cap", () => {
    expect(shouldRetainEmulatorOutput({ fileName: "game.nes", platform: "Unknown platform", size: MAX_BYTES })).toBe(
      true,
    );
  });

  it("skips unsupported platforms and oversized outputs", () => {
    expect(shouldRetainEmulatorOutput({ fileName: "game.bin", platform: "Unknown platform", size: 1 })).toBe(false);
    expect(shouldRetainEmulatorOutput({ fileName: "game.nes", size: MAX_BYTES + 1 })).toBe(false);
  });
});
