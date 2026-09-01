// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { lookupExpectedRom } from "../../../src/lib/apply/expected-rom-lookup.ts";
import type { ParsedIdentifyTitleMatch } from "../../../src/types/identify.ts";
import { useExpectedRomIdentification } from "../../../src/public/react/use-expected-rom-identification.ts";
import { useRomHashLookup } from "../../../src/public/react/use-rom-hash-lookup.ts";

// The lookup loads the whole identify pack set, so both hooks reach it through
// one seam; stubbing that seam tests their state machines without the runtime.
vi.mock("../../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom: vi.fn() }));
const mockedLookup = vi.mocked(lookupExpectedRom);

const MESSAGES = { invalid: "wrong length", invalidChars: "not hex" };

const match = (name: string): ParsedIdentifyTitleMatch => ({
  algorithm: "components",
  database: "test.pack",
  name,
  platform: "Test System",
  variant: "manual",
});

beforeEach(() => {
  mockedLookup.mockReset();
});

describe("useRomHashLookup", () => {
  const search = async (hash: string) => {
    const hook = renderHook(() => useRomHashLookup(MESSAGES));
    act(() => hook.result.current.setText(hash));
    await act(async () => {
      await hook.result.current.search();
    });
    return hook;
  };

  it("rejects a value that is not hex before looking anything up", async () => {
    const hook = await search("zzzz");

    expect(hook.result.current.error).toBe("not hex");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("rejects a hex value of no known checksum length", async () => {
    const hook = await search("abc");

    expect(hook.result.current.error).toBe("wrong length");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("normalizes the pasted value and keeps it as the expectation", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });

    const hook = await search("  D7AE93DF ");

    expect(mockedLookup).toHaveBeenCalledWith({ checksums: { crc32: "d7ae93df" } }, expect.anything());
    await waitFor(() => expect(hook.result.current.result).toBeDefined());
    expect(hook.result.current.result?.checks).toEqual({ checksums: { crc32: "d7ae93df" } });
    expect(hook.result.current.result?.identification.matches[0]?.name).toBe("Hello World (USA)");
    expect(hook.result.current.error).toBe("");
  });

  it("infers the algorithm from the digest length", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });

    await search("5d41402abc4b2a76b9719d911017c592");

    expect(mockedLookup).toHaveBeenCalledWith(
      { checksums: { md5: "5d41402abc4b2a76b9719d911017c592" } },
      expect.anything(),
    );
  });

  // "nothing matched" and "nothing could be asked" are different answers, and a
  // user acts on them differently: check the value, or install the data.
  it("separates an unknown checksum from unavailable data", async () => {
    mockedLookup.mockResolvedValue(undefined);
    const unknown = await search("deadbeef");
    expect(unknown.result.current.error).toContain("No ROM");
    expect(unknown.result.current.result).toBeUndefined();

    mockedLookup.mockResolvedValue({ matches: [], status: "unavailable" });
    const unavailable = await search("deadbeef");
    expect(unavailable.result.current.error).toContain("not available");
    expect(unavailable.result.current.result).toBeUndefined();
  });

  it("reports a thrown lookup instead of staying busy", async () => {
    mockedLookup.mockRejectedValue(new Error("pack read failed"));

    const hook = await search("d7ae93df");

    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.error).toBe("pack read failed");
  });

  it("clears the text and the result together", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });
    const hook = await search("d7ae93df");
    await waitFor(() => expect(hook.result.current.result).toBeDefined());

    act(() => hook.result.current.clear());

    expect(hook.result.current.text).toBe("");
    expect(hook.result.current.result).toBeUndefined();
    expect(hook.result.current.error).toBe("");
  });
});

describe("useExpectedRomIdentification", () => {
  it("looks a check up once and keeps the answer", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });
    const checks = { checksums: { crc32: "d7ae93df" }, size: 1024 };

    const hook = renderHook(({ value }) => useExpectedRomIdentification(value), {
      initialProps: { value: checks },
    });
    await waitFor(() => expect(hook.result.current?.status).toBe("matched"));

    // A new object with the same digests and size is the same check.
    hook.rerender({ value: { checksums: { crc32: "d7ae93df" }, size: 1024 } });
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });

  it("does not keep an answer after a disabled check changes", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });
    const first = { checksums: { crc32: "d7ae93df" } };

    const hook = renderHook(({ checks, enabled }) => useExpectedRomIdentification(checks, enabled), {
      initialProps: { checks: first, enabled: true },
    });
    await waitFor(() => expect(hook.result.current?.matches[0]?.name).toBe("Hello World (USA)"));

    hook.rerender({ checks: { checksums: { crc32: "3610a686" } }, enabled: false });

    expect(hook.result.current).toBeUndefined();
    expect(mockedLookup).toHaveBeenCalledTimes(1);
  });

  it("does not look up a check with no checksums", async () => {
    renderHook(() => useExpectedRomIdentification({ size: 1024 }));

    await waitFor(() => expect(mockedLookup).not.toHaveBeenCalled());
  });

  it("skips the lookup while disabled", async () => {
    renderHook(() => useExpectedRomIdentification({ checksums: { crc32: "d7ae93df" } }, false));

    await waitFor(() => expect(mockedLookup).not.toHaveBeenCalled());
  });

  // Unavailable data is not an identification; the card must fall back to the
  // check's own values rather than claim a verdict.
  it("reports no identification when the data is unavailable", async () => {
    mockedLookup.mockResolvedValue({ matches: [], status: "unavailable" });

    const hook = renderHook(() => useExpectedRomIdentification({ checksums: { crc32: "d7ae93df" } }));

    await waitFor(() => expect(mockedLookup).toHaveBeenCalled());
    expect(hook.result.current).toBeUndefined();
  });
});
