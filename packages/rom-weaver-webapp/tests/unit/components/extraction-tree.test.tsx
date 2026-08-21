// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractDrawer } from "../../../src/public/react/components/ds/extraction-tree.tsx";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { navigatorWith } from "../navigator-test-utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExtractDrawer", () => {
  it("copies the complete file name from a Files row", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <ExtractDrawer fileName="patches/v1.2/change.ips" fileSize={14} />
      </RomWeaverSettingsProvider>,
    );

    const row = container.querySelector("button.tree-row") as HTMLButtonElement;
    expect(row.getAttribute("aria-label")).toBe("Copy patches/v1.2/change.ips");
    fireEvent.click(row);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("patches/v1.2/change.ips"));
  });
});
