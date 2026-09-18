// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadCatalog } from "../../../src/presentation/localization/catalog.ts";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import {
  compareRomExpectation,
  RomExpectationCard,
  RomSearch,
} from "../../../src/public/react/components/ds/rom-expectation-card.tsx";
import type { ParsedIdentifyResolution, ParsedIdentifyTitleMatch } from "../../../src/types/identify.ts";
import type { useRomLookup } from "../../../src/public/react/use-rom-lookup.ts";

beforeAll(async () => {
  await loadCatalog("es");
});

const matched = (expectedComponents: Record<string, string | number>[]): ParsedIdentifyResolution => ({
  matches: [
    {
      algorithm: "crc32",
      database: "No-Intro",
      expectedComponents,
      name: "Metroid Fusion (USA)",
      platform: "Nintendo - Game Boy Advance",
      variant: "raw",
    },
  ],
  status: "matched",
});

/* The Identify drawer has groups of its own, so the assertions look only at the
   groups the Checks drawer heads with "Expected". */
const expectedGroups = (container: HTMLElement) =>
  [...container.querySelectorAll(".ck-group")].filter((group) =>
    group.querySelector(".ck-group-head")?.textContent?.startsWith("Expected"),
  );
const rows = (container: ParentNode) =>
  [...container.querySelectorAll(".ck")].map((row) =>
    [row.querySelector(".ck-k")?.textContent || "", row.querySelector(".ck-v")?.textContent || ""].join(" "),
  );

describe("RomExpectationCard", () => {
  it("merges the database checks into one Expected group named after the database", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: { crc32: "abcd1234" } }, source: "manual" }}
        identification={matched([{ crc32: "ffffffff", sha1: "1".repeat(40), size: 4194304 }])}
      />,
    );

    const group = expectedGroups(container)[0];
    expect(expectedGroups(container)).toHaveLength(1);
    expect(group?.querySelector(".ck-head-note")?.textContent).toBe("your checksum · No-Intro");
    const values = rows(group as ParentNode);
    // The check's own CRC32 wins; the database supplies what it never asserted.
    expect(values.some((row) => row.includes("abcd1234"))).toBe(true);
    expect(values.some((row) => row.includes("ffffffff"))).toBe(false);
    expect(values.some((row) => row.includes("1".repeat(40)))).toBe(true);
    expect(values.some((row) => row.includes("4194304"))).toBe(true);
    expect(container.textContent).not.toContain("From the database");
  });

  it("names the bundle or the patch as the authority", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: { crc32: "abcd1234" } }, name: "game.gba", source: "bundle" }}
        identification={matched([{ md5: "0".repeat(32) }])}
      />,
    );

    expect(expectedGroups(container)[0]?.querySelector(".ck-head-note")?.textContent).toBe("by the bundle · No-Intro");
  });

  it("renders the expectation's own rows alone when nothing identified it", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: { crc32: "abcd1234" }, size: 1024 }, source: "patch" }}
      />,
    );

    expect(expectedGroups(container)).toHaveLength(0);
    expect(container.textContent).toContain("Expected by a patch");
    expect(rows(container).some((row) => row.includes("1024"))).toBe(true);
  });

  it("localizes the expected-ROM card while keeping its checksum rows", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language: "es" }}>
        <RomExpectationCard
          expectation={{ checks: { checksums: { crc32: "abcd1234" }, size: 1024 }, source: "patch" }}
        />
      </RomWeaverSettingsProvider>,
    );

    expect(container.textContent).toContain("ROM esperada");
    expect(container.textContent).toContain("Esperada por un parche");
    expect(rows(container).some((row) => row.includes("CRC32 abcd1234"))).toBe(true);
    expect(rows(container).some((row) => row.includes("BYTES 1024"))).toBe(true);
  });

  it("opens both header variants on an identified ROM card", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: {} }, source: "name" }}
        identification={matched([
          {
            crc32: "abcd1234",
            filename: "Game.unh",
            ordinal: 0,
            size: 16384,
          },
          {
            crc32: "deadbeef",
            filename: "Game.nes",
            ordinal: 1,
            size: 16400,
          },
        ])}
      />,
    );

    const groups = expectedGroups(container);
    expect(groups).toHaveLength(0);
    const heads = [...container.querySelectorAll(".ck-group-head")].map((head) => head.textContent);
    expect(heads.some((head) => head?.startsWith("Unheadered ROM"))).toBe(true);
    expect(heads.some((head) => head?.startsWith("Headered ROM"))).toBe(true);
    expect(container.textContent).toContain("abcd1234");
    expect(container.textContent).toContain("deadbeef");
  });

  it("keeps the authored size with the matching header variant", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: { crc32: "abcd1234" }, size: 1024 }, source: "bundle" }}
        identification={matched([
          { crc32: "abcd1234", filename: "Game.unh", ordinal: 0, size: 16384 },
          { crc32: "deadbeef", filename: "Game.nes", ordinal: 1, size: 16400 },
        ])}
      />,
    );

    const groups = [...container.querySelectorAll<HTMLElement>(".ck-group")];
    const unheadered = groups.find((group) =>
      group.querySelector(".ck-group-head")?.textContent?.startsWith("Unheadered ROM"),
    );
    const headered = groups.find((group) =>
      group.querySelector(".ck-group-head")?.textContent?.startsWith("Headered ROM"),
    );
    expect(rows(unheadered as ParentNode)).toContain("BYTES 1024");
    expect(rows(headered as ParentNode)).toContain("BYTES 16400");
  });

  it("fills every component in a multi-track identified ROM card", () => {
    const { container } = render(
      <RomExpectationCard
        expectation={{ checks: { checksums: {} }, source: "name" }}
        identification={matched([
          {
            crc32: "11111111",
            filename: "game (Track 1).bin",
            ordinal: 0,
            role: "data_track",
            size: 2352,
            track: 1,
          },
          {
            crc32: "22222222",
            filename: "game (Track 2).bin",
            ordinal: 1,
            role: "audio_track",
            size: 4704,
            track: 2,
          },
        ])}
      />,
    );

    expect(expectedGroups(container)).toHaveLength(0);
    const heads = [...container.querySelectorAll(".ck-group-head")].map((head) => head.textContent);
    expect(heads.some((head) => head?.startsWith("game (Track 1).bin"))).toBe(true);
    expect(heads.some((head) => head?.startsWith("game (Track 2).bin"))).toBe(true);
    expect(container.textContent).toContain("11111111");
    expect(container.textContent).toContain("22222222");
    expect(container.textContent).toContain("2352");
    expect(container.textContent).toContain("4704");
  });
});

describe("RomSearch release choices", () => {
  const lookup = (overrides: Partial<ReturnType<typeof useRomLookup>> = {}) =>
    ({
      busy: false,
      choose: vi.fn(),
      chooseTitle: vi.fn(),
      clear: vi.fn(),
      error: "",
      leaveTitle: vi.fn(),
      result: undefined,
      search: vi.fn(),
      setText: vi.fn(),
      stage: "",
      text: "",
      title: undefined,
      titles: [],
      versions: [],
      ...overrides,
    }) as ReturnType<typeof useRomLookup>;

  it("shows release checksums with one list checkbox", () => {
    const choose = vi.fn();
    render(
      <RomSearch
        localizer={{ message: (key: string) => key } as never}
        lookup={lookup({
          versions: [
            {
              algorithm: "sha1",
              database: "Redump",
              expectedComponents: [
                {
                  crc32: "a1b2c3d4",
                  filename: "disc-1.bin",
                  md5: "m".repeat(32),
                  ordinal: 0,
                  role: "data_track",
                  sha1: "s".repeat(40),
                  sha256: "h".repeat(64),
                  size: 1,
                },
                { crc32: "d4c3b2a1", ordinal: 1, role: "audio_track", size: 2, track: 2 },
              ],
              name: "Game (USA)",
              platform: "Sony - PlayStation",
              region: "USA",
              variant: "raw",
            },
          ],
          choose,
        })}
      />,
    );

    const choice = screen.getByRole("button", { name: /Game \(USA\)/u });
    expect(choice.textContent).toContain("Sony - PlayStation");
    expect(choice.textContent).not.toContain("a1b2c3d4");
    expect(choice.textContent).toContain("disc-1.bin");
    expect(choice.textContent).toContain("Track 2");
    const expand = screen.getByRole("checkbox", { name: "ui.identify.showChecksums" }) as HTMLInputElement;
    expect(expand.checked).toBe(false);
    expect(choice.querySelectorAll("button")).toHaveLength(0);
    fireEvent.click(expand);
    expect(expand.checked).toBe(true);
    expect(screen.getByText("a1b2c3d4")).toBeTruthy();
    expect(screen.getByText("m".repeat(32))).toBeTruthy();
    expect(screen.getByText("s".repeat(40))).toBeTruthy();
    expect(screen.getByText("h".repeat(64))).toBeTruthy();
    fireEvent.click(choice);
    expect(choose).toHaveBeenCalledOnce();
  });

  it("keeps the query editable and announces a pending search", () => {
    render(
      <RomSearch
        localizer={{ message: (key: string) => (key === "ui.identify.searching" ? "Searching…" : key) } as never}
        lookup={lookup({ busy: true, stage: "", text: "Metroid" })}
      />,
    );

    const input = screen.getByRole("combobox");
    expect((input as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Searching…");
  });

  it.each([
    { filenames: ["Game.unh", "Game.nes"], labels: ["Unheadered ROM", "Headered ROM"], language: "en" },
    { filenames: ["Game.UNH"], labels: ["Unheadered ROM"], language: "en" },
    { filenames: ["Game.unh", "Game.nes"], labels: ["ROM sin cabecera", "ROM con cabecera"], language: "es" },
  ])("labels NES header variants for $filenames in $language", ({ filenames, labels, language }) => {
    const choose = vi.fn();
    const version = {
      algorithm: "name",
      database: "No-Intro",
      expectedComponents: filenames.map((filename, ordinal) => ({
        crc32: ordinal === 0 ? "abcd1234" : "deadbeef",
        filename,
        ordinal,
        size: ordinal === 0 ? 16384 : 16400,
      })),
      name: "Game (USA)",
      platform: "Nintendo - Nintendo Entertainment System",
      variant: "name",
    };
    const { container } = render(
      <RomWeaverSettingsProvider settings={{ language }}>
        <RomSearch
          localizer={{ message: (key: string) => key } as never}
          lookup={lookup({ choose, versions: [version] })}
        />
      </RomWeaverSettingsProvider>,
    );

    expect(
      [...container.querySelectorAll(".identify-search-result-component-name")].map((element) => element.textContent),
    ).toEqual(labels);
    const choice = container.querySelector(".identify-search-result-btn") as HTMLButtonElement;
    expect(choice.textContent).not.toContain("abcd1234");
    expect(choice.textContent).not.toContain(".unh");
    if (filenames.length > 1) {
      expect(choice.textContent).toContain(labels[0]);
      expect(choice.textContent).toContain(labels[1]);
    }
    fireEvent.click(screen.getByRole("checkbox"));
    expect(container.textContent).toContain("CRC32abcd1234");
    if (filenames.length > 1) expect(container.textContent).toContain("CRC32deadbeef");
    fireEvent.click(choice);
    expect(choose).toHaveBeenCalledWith(version);
    expect(version.expectedComponents.map((component) => component.filename)).toEqual(filenames);
  });

  it("starts on the first release and lets arrows move the Enter choice", () => {
    const choose = vi.fn();
    const versions: ParsedIdentifyTitleMatch[] = [
      { algorithm: "name", database: "test", name: "First", platform: "NES", variant: "raw" },
      { algorithm: "name", database: "test", name: "Second", platform: "NES", variant: "raw" },
    ];
    const { container } = render(
      <RomSearch
        localizer={{ message: (key: string) => key } as never}
        lookup={lookup({ choose, text: "games", versions })}
      />,
    );

    const input = container.querySelector<HTMLInputElement>(".identify-search-input");
    if (!input) throw new Error("the search input is missing");
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".identify-search-result-btn--version")];
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(buttons[0]?.getAttribute("aria-current")).toBe("true");
    expect(buttons[1]?.getAttribute("aria-current")).toBeNull();
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(options[1]?.getAttribute("aria-selected")).toBe("false");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(buttons[0]?.getAttribute("aria-current")).toBeNull();
    expect(buttons[1]?.getAttribute("aria-current")).toBe("true");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(choose).toHaveBeenCalledWith(versions[1]);
  });
});

describe("compareRomExpectation", () => {
  const expectation = { checks: { checksums: { crc32: "abcd1234" }, size: 1024 }, source: "manual" } as const;

  it("is ok when every compared field matches", () => {
    expect(compareRomExpectation(expectation, { checksums: { crc32: "ABCD1234" }, size: 1024 })).toBe("ok");
  });

  it("is bad on a checksum mismatch", () => {
    expect(compareRomExpectation(expectation, { checksums: { crc32: "deadbeef" }, size: 1024 })).toBe("bad");
  });

  it("is bad on a size mismatch", () => {
    expect(compareRomExpectation(expectation, { checksums: { crc32: "abcd1234" }, size: 2048 })).toBe("bad");
  });

  it("has no verdict when nothing could be compared", () => {
    expect(compareRomExpectation(expectation, { checksums: { md5: "0".repeat(32) } })).toBeUndefined();
    expect(compareRomExpectation(undefined, { checksums: { crc32: "abcd1234" } })).toBeUndefined();
  });
});
