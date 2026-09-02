// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  compareRomExpectation,
  RomExpectationCard,
} from "../../../src/public/react/components/ds/rom-expectation-card.tsx";
import type { ParsedIdentifyResolution } from "../../../src/types/identify.ts";

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
