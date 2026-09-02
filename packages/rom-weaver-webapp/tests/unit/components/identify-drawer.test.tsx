// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentifyDrawer } from "../../../src/webapp/components/identify-drawer.tsx";
import { navigatorWith } from "../navigator-test-utils.ts";

const gbaMatch = (name: string) => ({
  algorithm: "crc32",
  // The pack-file shape the backend really reports. It is a file name, not a
  // source, so it must not reach the drawer.
  database: "nintendo-game-boy-advance.pack",
  name,
  // Upper case on purpose: identify databases report platforms in upper case,
  // and the drawer must still abbreviate them ("GBA").
  platform: "NINTENDO GAME BOY ADVANCE",
  provenance: [{ source: "opengood", sourceName: "SnowflakePowered/opengood" }],
  variant: "raw",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IdentifyDrawer", () => {
  it("lists every name as a copyable row", async () => {
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

    // All three records remain available in the Names group. There is no
    // separate label for the source or readable form.
    expect(container.querySelectorAll(".identify-name-row .ck-k")).toHaveLength(0);
    const nameRows = container.querySelectorAll('button[aria-label^="Copy name "]');
    expect(nameRows).toHaveLength(3);
    expect(nameRows[0]?.textContent).toContain("Pokemon - Emerald Version (UE) [!]");
    // A name too long for half a row takes the whole row instead of wrapping
    // over three lines beside an empty column.
    for (const row of container.querySelectorAll(".identify-name-row")) {
      expect(row.className).not.toContain("ck-half");
    }
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("GBA");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("CRC32");
    // The record's provenance names the source; the pack file name never does.
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("OpenGood");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).not.toContain(".pack");

    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", navigatorWith({ clipboard: { writeText } }));
    fireEvent.click(
      container.querySelector('button[aria-label="Copy name Pokemon - Emerald Version (UE) [!]"]') as HTMLButtonElement,
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Pokemon - Emerald Version (UE) [!]"));
  });

  it("lists a name supplied by another database", () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [
            {
              ...gbaMatch("Legend of Zelda, The (USA)"),
              alternateNames: ["Legend of Zelda, The (U) (PRG0) [!]"],
            },
          ],
          status: "matched",
        }}
      />,
    );

    const names = [...container.querySelectorAll('button[aria-label^="Copy name "]')];
    expect(names.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Legend of Zelda, The (USA)"),
      expect.stringContaining("Legend of Zelda, The (U) (PRG0) [!]"),
    ]);
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("PRG0: Program revision 0");
  });

  it("pairs a short name with its neighbour", () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [gbaMatch("Tetris"), gbaMatch("Mario")],
          status: "matched",
        }}
      />,
    );

    const rows = container.querySelectorAll(".identify-name-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.className).toContain("ck-half");
  });

  it("translates dump tags and labels their source", () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [{ ...gbaMatch("Legacy Game"), dumpTags: ["!", "b1", "T-Eng", "c", "x"] }],
          status: "matched",
        }}
      />,
    );

    const evidence = container.querySelector(".identify-drawer-evidence");
    expect(evidence?.textContent).toContain("Source");
    expect(evidence?.textContent).not.toContain("Provenance");
    expect(evidence?.textContent).toContain("Verified dump");
    expect(evidence?.textContent).toContain("Bad dump 1");
    expect(evidence?.textContent).toContain("English translation (obsolete)");
    expect(evidence?.textContent).toContain("Faulty checksum routine");
    expect(evidence?.textContent).toContain("Bad checksum");
    expect(evidence?.textContent).not.toContain("b1");
    expect(evidence?.textContent).not.toContain("T-Eng");
  });

  it("lists every candidate name and states the candidate count", () => {
    const { container } = render(
      <IdentifyDrawer
        identification={{
          matches: [gbaMatch("Twin Game (USA)"), gbaMatch("Twin Game (Europe)")],
          status: "ambiguous",
        }}
        memberPath="Games/twin.gba"
      />,
    );

    expect(container.querySelectorAll('button[aria-label^="Copy name "]')).toHaveLength(2);
    expect(container.textContent).toContain("2 possible matches");
    expect(container.querySelector(".identify-drawer-evidence")?.textContent).toContain("Games/twin.gba");
  });

  it("reports a database that answered with no record, so the staged slot resolves", () => {
    const { container } = render(<IdentifyDrawer identification={{ matches: [], status: "unknown" }} />);
    expect(container.querySelector(".identify-drawer .rb")?.textContent).toBe("Unidentified");
    // The readout is the whole answer: no body sub-text, no "Evidence" head.
    expect(container.querySelector(".ck-group-head")).toBeNull();
    expect(container.querySelector(".identify-drawer-body")?.textContent).toBe("");
  });

  it("renders nothing when the packs never loaded", () => {
    const { container } = render(<IdentifyDrawer identification={{ matches: [], status: "unavailable" }} />);
    expect(container.innerHTML).toBe("");
  });
});
