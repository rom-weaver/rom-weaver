// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentifyDrawer } from "../../../src/webapp/components/identify-drawer.tsx";
import { navigatorWith } from "../navigator-test-utils.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IdentifyDrawer", () => {
  it("shows copyable aliases and the platform and method used for the match", async () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [
            {
              algorithm: "crc32",
              database: "OpenGood",
              name: "Pokemon - Emerald Version (UE) [!]",
              platform: "Nintendo Game Boy Advance",
              variant: "raw",
            },
            {
              algorithm: "crc32",
              database: "OpenGood",
              name: "Pokemon - Emerald Version (USA, Europe)",
              platform: "Nintendo Game Boy Advance",
              variant: "raw",
            },
            {
              algorithm: "crc32",
              database: "OpenGood",
              name: "Pokemon - Emerald Version (UE) [b1]",
              platform: "Nintendo Game Boy Advance",
              variant: "raw",
            },
          ],
          status: "matched",
        }}
      />,
    );

    expect(container.querySelector(".identify-drawer-title")?.textContent).toBe(
      "Pokemon - Emerald Version (USA, Europe)",
    );
    expect(container.querySelectorAll(".identify-alias-row")).toHaveLength(3);
    expect(container.querySelector(".identify-alias-row .ck-k")?.textContent).toBe("Standard");
    expect(container.querySelector(".identify-alias-row .ck-v")?.textContent).toBe(
      "Pokemon - Emerald Version (USA, Europe)",
    );
    expect(container.querySelector('button[aria-label^="Copy alias name "] .ck-v')?.textContent).toBe(
      "Pokemon - Emerald Version (UE) [!]",
    );
    expect(container.querySelectorAll('button[aria-label^="Copy alias name "]')).toHaveLength(2);
    expect(
      container.querySelector('button[aria-label="Copy standard name Pokemon - Emerald Version (USA, Europe)"]'),
    ).toBeTruthy();
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("Nintendo Game Boy Advance");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("CRC32");
    expect(container.querySelector('button[aria-label="Copy Platform"]')).toBeTruthy();
    expect(container.querySelector('button[aria-label="Copy Method"]')).toBeTruthy();

    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    fireEvent.click(container.querySelector('button[aria-label^="Copy alias name "]') as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Pokemon - Emerald Version (UE) [!]"));
  });
});
