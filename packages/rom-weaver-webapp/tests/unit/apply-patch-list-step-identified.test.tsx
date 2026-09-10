// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupExpectedRom } from "../../src/lib/apply/expected-rom-lookup.ts";
import { ApplyPatchListStep } from "../../src/public/react/apply-patch-list-step.tsx";
import type { PatcherStackController } from "../../src/public/react/patcher-form.ts";
import type { PatchStackItemState } from "../../src/public/react/patcher-presentation.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom: vi.fn() }));

const mockedLookup = vi.mocked(lookupExpectedRom);

const item = (): PatchStackItemState =>
  ({
    key: "patch-0",
    index: 0,
    fileName: "first.ips",
    fileSize: 1024,
    validationState: "valid",
    validationValues: [],
    validationLabel: "Checks",
    validationMessage: "",
    validationActualValue: "",
    targetOptions: [{ value: "rom-a", label: "Game A" }],
    targetValue: "rom-a",
    canRemove: true,
  }) as unknown as PatchStackItemState;

describe("ApplyPatchListStep identified check titles", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it("names the identified title under the authored input check group", async () => {
    mockedLookup.mockResolvedValue({
      matches: [
        {
          algorithm: "sha1",
          database: "redump",
          name: "Two Track Quest",
          platform: "Test Disc System",
          region: "USA",
          variant: "raw",
        },
      ],
      status: "matched",
    });
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyPatchListStep
          bundleMeta={[{ id: "patch-0", inputChecks: { checksums: { crc32: "1234abcd" } } }]}
          bundleSessionMatches
          patches={[item()]}
          patchStack={{ setPatchOption: vi.fn(), setPatchTarget: vi.fn() } as unknown as PatcherStackController}
        />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() =>
      expect(container.querySelector(".ck-group-title")?.textContent).toBe("Two Track Quest (USA) — Test Disc System"),
    );
  });

  it("does not repeat a region the title already carries", async () => {
    mockedLookup.mockResolvedValue({
      matches: [
        {
          algorithm: "sha1",
          database: "redump",
          name: "Two Track Quest (USA)",
          platform: "Test Disc System",
          region: "USA",
          variant: "raw",
        },
      ],
      status: "matched",
    });
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ApplyPatchListStep
          bundleMeta={[{ id: "patch-0", inputChecks: { checksums: { crc32: "1234abcd" } } }]}
          bundleSessionMatches
          patches={[item()]}
          patchStack={{ setPatchOption: vi.fn(), setPatchTarget: vi.fn() } as unknown as PatcherStackController}
        />
      </RomWeaverSettingsProvider>,
    );

    await waitFor(() =>
      expect(container.querySelector(".ck-group-title")?.textContent).toBe("Two Track Quest (USA) — Test Disc System"),
    );
  });
});
