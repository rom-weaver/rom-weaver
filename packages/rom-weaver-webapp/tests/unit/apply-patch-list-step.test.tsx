// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApplyPatchListStep } from "../../src/public/react/apply-patch-list-step.tsx";
import type { PatcherStackController } from "../../src/public/react/patcher-form.ts";
import type { PatchStackItemState } from "../../src/public/react/patcher-presentation.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";

const item = (index: number, overrides: Partial<PatchStackItemState> = {}): PatchStackItemState =>
  ({
    key: `patch-${index}`,
    index,
    fileName: index === 0 ? "folder/first.ips" : "second.bps",
    fileSize: index === 0 ? 1024 : 2048,
    archiveFileName: index === 0 ? "patches.zip" : "",
    archivePathEntries:
      index === 0
        ? [
            { fileName: "patches.zip", sourceSize: 4096, outputSize: 1024, decompressionTimeMs: 12 },
            { fileName: "folder" },
          ]
        : undefined,
    decompressionTimeMs: 8,
    validationState: "valid",
    sourceChecksumState: "valid",
    validationValues: ["in crc32=1234abcd", "in size=2048", "out sha1=0123456789abcdef0123456789abcdef01234567"],
    validationLabel: "Checks",
    validationMessage: "",
    validationActualValue: "",
    targetOptions: [
      { value: "rom-a", label: "Game A" },
      { value: "rom-b", label: "Game B" },
    ],
    targetValue: "rom-a",
    showHeaderOption: true,
    headerStrippedBytes: 512,
    headerAutoDecided: true,
    headerAutoMode: "strip",
    showN64ByteOrderOption: false,
    canMoveUp: index > 0,
    canMoveDown: index === 0,
    canRemove: true,
    ...overrides,
  }) as PatchStackItemState;

const stack = (overrides: Partial<PatcherStackController> = {}): PatcherStackController =>
  ({
    removeItem: vi.fn(),
    reorder: vi.fn(),
    replaceItem: vi.fn(),
    setPatchOption: vi.fn(),
    setPatchTarget: vi.fn(),
    ...overrides,
  }) as PatcherStackController;

const renderList = (overrides: Partial<Parameters<typeof ApplyPatchListStep>[0]> = {}) => {
  const patchStack = overrides.patchStack || stack();
  return render(
    <RomWeaverSettingsProvider settings={{}}>
      <ApplyPatchListStep patches={overrides.patches || [item(0), item(1)]} patchStack={patchStack} {...overrides} />
    </RomWeaverSettingsProvider>,
  );
};

describe("ApplyPatchListStep", () => {
  it("renders an empty stack with its supplied empty state", () => {
    const { container } = renderList({ patches: [], emptyState: <p>Drop a patch here</p> });

    expect(container.querySelector("#rom-weaver-row-patch-stack")).toBeTruthy();
    expect(container.textContent).toContain("Drop a patch here");
    expect(container.querySelector(".step-num")?.textContent).toBe("0x03");
  });

  it("renders patch metadata, verification details, chain warnings, and disabled totals", () => {
    const first = item(0, {
      chainVerdict: {
        basis: "base",
        basisSource: "inferred_base",
        matched: { kind: "base", variant: "raw" },
      },
      validationState: "invalid",
      validationMessage: "validation failed: patch does not match",
    });
    const second = item(1, {
      chainVerdict: {
        basis: "previous",
        basisSource: "inferred_chain",
        matched: { kind: "patch_output", index: 0 },
      },
    });
    const { container } = renderList({
      patches: [first, second],
      bundleOutputCheckHint: true,
      bundleSessionMatches: true,
      disabledFlags: [false, true],
      fault: true,
      notice: <p id="list-notice">Patch source loaded</p>,
      overrideAvailable: true,
      bundleMeta: [
        {
          id: "patch-0",
          name: "First update",
          version: "1.0",
          author: "Tester",
          label: "optional",
          description: "Changes the title screen",
          inputChecks: { checksums: {}, size: undefined },
          outputChecks: { checksums: {}, size: undefined },
        },
        undefined,
      ],
    });

    expect(container.textContent).toContain("1 file");
    expect(container.textContent).toContain("1 disabled");
    expect(container.textContent).toContain("First update");
    expect(container.textContent).toContain("Tester");
    expect(container.textContent).toContain("Validation failed");
    expect(container.textContent).toContain("Patch does not match");
    expect(container.textContent).toContain("CRC32");
    expect(container.textContent).toContain("SHA-1");
    expect(container.textContent).toContain(
      "The expected output is verified only when every patch in the bundle is applied.",
    );
    expect(container.textContent).toContain("Patch source loaded");
  });

  it("updates patch options, metadata, replacement, removal, and toggles", async () => {
    const patchStack = stack();
    const onBundleMetaChange = vi.fn();
    const onTogglePatch = vi.fn();
    const { container } = renderList({ patchStack, onBundleMetaChange, onTogglePatch });

    fireEvent.change(container.querySelector("#rom-weaver-select-patch-target-0") as HTMLSelectElement, {
      target: { value: "rom-b" },
    });
    expect(patchStack.setPatchTarget).toHaveBeenCalledWith(0, "rom-b");
    fireEvent.change(container.querySelector("#rom-weaver-patch-header-mode-0") as HTMLSelectElement, {
      target: { value: "keep" },
    });
    expect(patchStack.setPatchOption).toHaveBeenCalledWith(0, { header: "keep", revalidate: true });

    fireEvent.click(screen.getByRole("checkbox", { name: "Include folder/first" }));
    expect(onTogglePatch).toHaveBeenCalledWith(0);
    fireEvent.click(container.querySelector("#rom-weaver-patch-menu-0") as HTMLButtonElement);
    fireEvent.click(container.querySelector("#rom-weaver-patch-replace-0") as HTMLButtonElement);
    const replacement = new File(["patch"], "replacement.ips", { type: "application/octet-stream" });
    fireEvent.change(container.querySelector("#rom-weaver-patch-replace-input-0") as HTMLInputElement, {
      target: { files: [replacement] },
    });
    expect(patchStack.replaceItem).toHaveBeenCalledWith(0, replacement);

    fireEvent.click(container.querySelector("#rom-weaver-patch-menu-1") as HTMLButtonElement);
    fireEvent.click(container.querySelector("#rom-weaver-patch-menu-remove-1") as HTMLButtonElement);
    expect(patchStack.removeItem).toHaveBeenCalledWith(1);

    fireEvent.click(container.querySelector("#rom-weaver-patch-menu-0") as HTMLButtonElement);
    fireEvent.click(container.querySelector("#rom-weaver-patch-meta-edit-0") as HTMLButtonElement);
    const name = container.querySelector("#rom-weaver-patch-name-0") as HTMLInputElement;
    fireEvent.change(name, { target: { value: " Renamed " } });
    fireEvent.blur(name);
    expect(onBundleMetaChange).toHaveBeenCalledWith(0, { name: "Renamed" });
    fireEvent.click(container.querySelector("#rom-weaver-patch-meta-edit-0") as HTMLButtonElement);

    const checkAdd = container.querySelector("#rom-weaver-patch-input-add-check-0") as HTMLSelectElement;
    fireEvent.change(checkAdd, { target: { value: "md5" } });
    const check = container.querySelector("#rom-weaver-patch-input-md5-0") as HTMLInputElement;
    fireEvent.change(check, { target: { value: "bad" } });
    fireEvent.blur(check);
    expect(container.querySelector("#rom-weaver-patch-input-md5-0-err")?.textContent).toContain("hex characters");
    fireEvent.change(check, { target: { value: "0123456789abcdef0123456789abcdef" } });
    fireEvent.blur(check);
    expect(onBundleMetaChange).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ inputChecks: expect.objectContaining({ checksums: expect.any(Object) }) }),
    );
    await waitFor(() => expect(container.querySelector("#rom-weaver-patch-input-md5-0")).toBeNull());
  });

  it("supports bulk metadata, order editing, and an order repair action", () => {
    const patchStack = stack();
    const onBundleMetaBulkChange = vi.fn();
    const onTogglePatch = vi.fn();
    const { container } = renderList({
      patchStack,
      onBundleMetaBulkChange,
      onTogglePatch,
      disabledFlags: [false, false],
      patches: [
        item(0),
        item(1, {
          chainVerdict: {
            basis: "previous",
            basisSource: "declared",
            matched: { kind: "patch_output", index: 0 },
            expectedPredecessor: 0,
          },
        }),
      ],
      bundleMeta: [{ version: "1" }, { version: "2" }],
    });

    fireEvent.click(container.querySelector(".patch-bulk-edit-button") as HTMLButtonElement);
    const version = container.querySelector("#rom-weaver-shared-patch-version") as HTMLInputElement;
    const author = container.querySelector("#rom-weaver-shared-patch-author") as HTMLInputElement;
    fireEvent.change(version, { target: { value: "3.0" } });
    fireEvent.change(author, { target: { value: "Team" } });
    fireEvent.change(container.querySelector("#rom-weaver-shared-patch-enablement") as HTMLSelectElement, {
      target: { value: "none" },
    });
    fireEvent.submit(container.querySelector("#rom-weaver-bulk-patch-meta") as HTMLFormElement);
    expect(onBundleMetaBulkChange).toHaveBeenCalledWith({ author: "Team", version: "3.0" });
    expect(onTogglePatch).toHaveBeenCalledWith(0);
    expect(onTogglePatch).toHaveBeenCalledWith(1);

    const handles = container.querySelectorAll(".phandle:not(.phandle-input)");
    fireEvent.click(handles[0] as HTMLButtonElement);
    const position = container.querySelector(".phandle-input") as HTMLInputElement;
    fireEvent.change(position, { target: { value: "2" } });
    fireEvent.keyDown(position, { key: "Enter" });
    fireEvent.blur(position);
    expect(patchStack.reorder).toHaveBeenCalledWith(0, 1);
    expect(container.querySelector("#rom-weaver-patch-order-note")).toBeTruthy();
    fireEvent.click(container.querySelector("#rom-weaver-button-fix-patch-order") as HTMLButtonElement);
    expect(patchStack.reorder).toHaveBeenCalledWith(1, 1);
  });
});
