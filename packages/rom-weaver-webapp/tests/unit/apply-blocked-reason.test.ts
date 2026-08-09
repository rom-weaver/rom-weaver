import { describe, expect, it } from "vitest";
import { getApplyBlockedReason } from "../../src/public/react/patcher-view-models.ts";

// Pins the wording and the precedence of the "why can't I press Apply" hint. A
// disabled button with no reason is the failure this replaces, so every
// precondition must produce a non-empty string, and the FIRST unmet one wins.

const base = {
  bundleVerificationError: "",
  busy: false,
  checksumPreflightBlocked: false,
  enabledPatchCount: 1,
  hasPendingDownload: false,
  patchCount: 1,
  romCount: 1,
};

describe("getApplyBlockedReason", () => {
  it("returns nothing when the run is ready", () => {
    expect(getApplyBlockedReason(base)).toBe("");
  });

  it("stays quiet while running or while a download is waiting", () => {
    expect(getApplyBlockedReason({ ...base, busy: true, romCount: 0 })).toBe("");
    expect(getApplyBlockedReason({ ...base, hasPendingDownload: true, romCount: 0 })).toBe("");
  });

  it("names the missing ROM before the missing patch", () => {
    const reason = getApplyBlockedReason({ ...base, patchCount: 0, romCount: 0 });
    expect(reason).toContain("Add a ROM");
  });

  it("names the missing patch", () => {
    expect(getApplyBlockedReason({ ...base, enabledPatchCount: 0, patchCount: 0 })).toContain("patch file");
  });

  it("names an all-off patch stack", () => {
    expect(getApplyBlockedReason({ ...base, enabledPatchCount: 0 })).toContain("switched off");
  });

  it("names a failing checksum preflight", () => {
    expect(getApplyBlockedReason({ ...base, checksumPreflightBlocked: true })).toContain("Apply anyway");
  });

  it("falls back to the bundle verification error", () => {
    expect(getApplyBlockedReason({ ...base, bundleVerificationError: "bundle broke" })).toBe("bundle broke");
  });
});
