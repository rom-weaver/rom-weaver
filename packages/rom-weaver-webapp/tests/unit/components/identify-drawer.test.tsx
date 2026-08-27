// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentifyDrawer } from "../../../src/webapp/components/identify-drawer.tsx";
import { navigatorWith } from "../navigator-test-utils.ts";

const gbaMatch = (name: string) => ({
  algorithm: "crc32",
  database: "OpenGood",
  name,
  // Upper case on purpose: identify databases report platforms in upper case,
  // and the drawer must still abbreviate them ("GBA").
  platform: "NINTENDO GAME BOY ADVANCE",
  variant: "raw",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IdentifyDrawer", () => {
  it("lists every name as a copyable row, the standard name included", async () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [
            gbaMatch("Pokemon - Emerald Version (UE) [!]"),
            gbaMatch("Pokemon - Emerald Version (USA, Europe)"),
            gbaMatch("Pokemon - Emerald Version (U,E) [!]"),
          ],
          status: "matched",
        }}
      />,
    );

    // All three records normalize to one display name, so there is one standard name…
    expect(container.querySelector(".identify-drawer-label")?.textContent).toBe("Standard name");
    expect(container.querySelectorAll(".identify-drawer-title")).toHaveLength(1);
    expect(container.querySelector(".identify-drawer-title")?.textContent).toBe(
      "Pokemon - Emerald Version (USA, Europe)",
    );
    // …the Names group lists it as a copyable row next to the two raw aliases.
    expect(container.querySelectorAll('button[aria-label^="Copy standard name "]')).toHaveLength(1);
    expect(container.querySelectorAll('button[aria-label^="Copy alias name "]')).toHaveLength(2);
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("GBA");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("CRC32");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("OpenGood");

    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    fireEvent.click(container.querySelector('button[aria-label^="Copy alias name "]') as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Pokemon - Emerald Version (UE) [!]"));
  });

  it("pluralizes the standard-name heading and states the candidate count", () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [gbaMatch("Twin Game (USA)"), gbaMatch("Twin Game (Europe)")],
          status: "ambiguous",
        }}
        memberPath="Games/twin.gba"
      />,
    );

    expect(container.querySelector(".identify-drawer-label")?.textContent).toBe("Standard names");
    expect(container.querySelectorAll(".identify-drawer-title")).toHaveLength(2);
    expect(container.textContent).toContain("2 possible matches");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("Games/twin.gba");
  });

  it("renders nothing when there is no match to describe", () => {
    const { container } = render(<IdentifyDrawer identification={{ matches: [], status: "unknown" }} />);
    expect(container.innerHTML).toBe("");
  });
});
