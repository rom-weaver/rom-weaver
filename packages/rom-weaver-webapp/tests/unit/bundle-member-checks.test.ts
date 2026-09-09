import { describe, expect, it } from "vitest";
import {
  componentChecks,
  fillMemberLaneChecks,
  memberComponent,
  memberTrackNumber,
} from "../../src/lib/bundle/bundle-member-checks.ts";
import type { BundleApplySession } from "../../src/lib/bundle/bundle-session-model.ts";
import type { ParsedIdentifyExpectedComponent, ParsedIdentifyResolution } from "../../src/types/identify.ts";

const component = (overrides: Partial<ParsedIdentifyExpectedComponent> = {}): ParsedIdentifyExpectedComponent => ({
  ordinal: 0,
  role: "primary_payload",
  size: 100,
  ...overrides,
});

const entry = (overrides: Partial<BundleApplySession["entries"][number]> = {}): BundleApplySession["entries"][number] =>
  ({
    acquisition: { kind: "url", url: "https://example.test/patch.bps" },
    fileName: "patch.bps",
    optional: false,
    ...overrides,
  }) as BundleApplySession["entries"][number];

const matched = (components: ParsedIdentifyExpectedComponent[]): ParsedIdentifyResolution => ({
  matches: [
    {
      algorithm: "sha1",
      database: "redump",
      expectedComponents: components,
      name: "Two Track Quest (USA)",
      platform: "Test Disc System",
      variant: "raw",
    },
  ],
  status: "matched",
});

describe("memberTrackNumber", () => {
  it("reads the digits after the track word, skipping spaces, underscores and dashes", () => {
    expect(memberTrackNumber("track01.bin")).toBe(1);
    expect(memberTrackNumber("Game (USA) (Track 2).bin")).toBe(2);
    expect(memberTrackNumber("disc/Game_Track_10.bin")).toBe(10);
    expect(memberTrackNumber("game-track-3.bin")).toBe(3);
  });

  it("reports no track for a name without one", () => {
    expect(memberTrackNumber("data.bin")).toBeUndefined();
  });
});

describe("memberComponent", () => {
  const components = [
    component({ filename: "Game (USA) (Track 1).bin", ordinal: 0, track: 1 }),
    component({ filename: "Game (USA) (Track 2).bin", ordinal: 1, track: 2 }),
  ];

  it("matches an exact file name first, case-insensitively and by basename", () => {
    expect(memberComponent(components, "disc/game (usa) (track 2).bin")?.ordinal).toBe(1);
  });

  it("falls back to the track number when no name matches", () => {
    expect(memberComponent(components, "track02.bin")?.ordinal).toBe(1);
  });

  it("matches nothing when the member names no track and no file", () => {
    expect(memberComponent(components, "data.bin")).toBeUndefined();
  });
});

describe("componentChecks", () => {
  it("keeps crc32/md5/sha1 and a positive size", () => {
    expect(
      componentChecks(component({ crc32: "1234abcd", md5: "0".repeat(32), sha256: "f".repeat(64), size: 2048 })),
    ).toEqual({ checksums: { crc32: "1234abcd", md5: "0".repeat(32) }, size: 2048 });
  });

  it("drops a zero size and reports nothing for a component with no usable value", () => {
    expect(componentChecks(component({ crc32: "1234abcd", size: 0 }))).toEqual({ checksums: { crc32: "1234abcd" } });
    expect(componentChecks(component({ sha256: "f".repeat(64), size: 0 }))).toBeUndefined();
  });
});

describe("fillMemberLaneChecks", () => {
  const components = [
    component({ crc32: "aaaaaaaa", size: 10, track: 1 }),
    component({ crc32: "bbbbbbbb", size: 20, track: 2 }),
  ];

  it("fills only the first entry of each rom-member lane", () => {
    const entries = [
      entry({ target: { member: "track01.bin", rom: true } }),
      entry({ target: { member: "track02.bin", rom: true } }),
      entry({ target: { member: "track01.bin", rom: true } }),
    ];

    const fills = fillMemberLaneChecks(entries, matched(components));

    expect([...fills.keys()]).toEqual([0, 1]);
    expect(fills.get(0)).toEqual({ checksums: { crc32: "aaaaaaaa" }, size: 10 });
    expect(fills.get(1)).toEqual({ checksums: { crc32: "bbbbbbbb" }, size: 20 });
  });

  it("skips lanes whose first entry declares an input or input checks, and unscoped targets", () => {
    const entries = [
      entry({ input: { rom: true }, target: { member: "track01.bin", rom: true } }),
      entry({ inputChecks: { checksums: { crc32: "cccccccc" } }, target: { member: "track02.bin", rom: true } }),
      entry({ target: { rom: true } }),
      entry({}),
    ];

    expect(fillMemberLaneChecks(entries, matched(components)).size).toBe(0);
  });

  it("fills nothing for a single-component record or an unmatched lookup", () => {
    const entries = [entry({ target: { member: "track01.bin", rom: true } })];

    expect(fillMemberLaneChecks(entries, matched([components[0] as ParsedIdentifyExpectedComponent])).size).toBe(0);
    expect(fillMemberLaneChecks(entries, { matches: [], status: "unknown" }).size).toBe(0);
    expect(fillMemberLaneChecks(entries, undefined).size).toBe(0);
  });
});
