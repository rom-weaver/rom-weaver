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
import type { ParsedIdentifyResolution } from "../../../src/types/identify.ts";
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

  it("shows each available checksum and platform before a release is selected", () => {
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
    expect(choice.textContent).toContain("CRC32a1b2c3d4");
    expect(choice.textContent).toContain(`MD5${"m".repeat(32)}`);
    expect(choice.textContent).toContain(`SHA-1${"s".repeat(40)}`);
    expect(choice.textContent).toContain(`SHA-256${"h".repeat(64)}`);
    expect(choice.textContent).toContain("disc-1.bin");
    expect(choice.textContent).toContain("Track 2");
    expect(
      [...choice.querySelectorAll(".identify-search-result-checksum-label")].map((label) => label.textContent),
    ).toEqual(["CRC32", "MD5", "SHA-1", "SHA-256", "CRC32"]);
    expect(choice.querySelectorAll("button")).toHaveLength(0);
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

    const input = screen.getByRole("textbox");
    expect((input as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Searching…");
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
