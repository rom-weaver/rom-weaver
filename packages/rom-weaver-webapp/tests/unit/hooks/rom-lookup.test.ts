// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  lookupExpectedRom,
  searchExpectedRomByName,
  searchExpectedRomTitles,
} from "../../../src/lib/apply/expected-rom-lookup.ts";
import type { ParsedIdentifyTitleMatch } from "../../../src/types/identify.ts";
import { useExpectedRomIdentification } from "../../../src/public/react/use-expected-rom-identification.ts";
import { useRomLookup } from "../../../src/public/react/use-rom-lookup.ts";
import { RomSearch } from "../../../src/public/react/components/ds/rom-expectation-card.tsx";
import { createBrowserLocalizer } from "../../../src/presentation/localization/index.ts";

// Every lookup reaches the identify data through one seam; stubbing that seam
// tests the hooks' state machines without the runtime.
vi.mock("../../../src/lib/apply/expected-rom-lookup.ts", () => ({
  lookupExpectedRom: vi.fn(),
  searchExpectedRomByName: vi.fn(),
  searchExpectedRomTitles: vi.fn(),
}));
const mockedLookup = vi.mocked(lookupExpectedRom);
const mockedByName = vi.mocked(searchExpectedRomByName);
const mockedTitles = vi.mocked(searchExpectedRomTitles);

const MESSAGES = {
  failed: "failed",
  hashInvalid: "wrong length",
  hashNoMatch: "No ROM has this checksum",
  hashUnavailable: "checksum data not available",
  nameNoMatch: "No game has that name",
  nameUnavailable: "name data not available",
  tooShort: "too short",
  versionsNoMatch: "no versions",
};

const match = (name: string, extra: Partial<ParsedIdentifyTitleMatch> = {}): ParsedIdentifyTitleMatch => ({
  algorithm: "components",
  database: "test.pack",
  name,
  platform: "Test System",
  variant: "manual",
  ...extra,
});

const TITLE = { name: "Hello World", platform: "Test System", slug: "test-system" };

beforeEach(() => {
  mockedLookup.mockReset();
  mockedByName.mockReset();
  mockedTitles.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("useRomLookup", () => {
  const search = async (text: string) => {
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText(text));
    await act(async () => {
      await hook.result.current.search();
    });
    return hook;
  };

  it("searches the latest typed name after a pause", async () => {
    vi.useFakeTimers();
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("he"));
    await act(() => vi.advanceTimersByTimeAsync(200));
    act(() => hook.result.current.setText("hello snes"));
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(mockedTitles).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mockedTitles).toHaveBeenCalledExactlyOnceWith("hello snes", expect.anything());
    expect(hook.result.current.titles).toEqual([TITLE]);
  });

  it("waits for composition to end before searching", async () => {
    vi.useFakeTimers();
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("ma"));
    act(() => hook.result.current.setText("mario", true));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(mockedTitles).not.toHaveBeenCalled();
    expect(hook.result.current.text).toBe("mario");
    act(() => hook.result.current.setText("mario", false));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(mockedTitles).toHaveBeenCalledExactlyOnceWith("mario", expect.anything());
  });

  it("does not repeat an explicit submit after the typing delay", async () => {
    vi.useFakeTimers();
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });
    const hook = await search("hello");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mockedTitles).toHaveBeenCalledTimes(1);
    expect(hook.result.current.titles).toEqual([TITLE]);
  });

  it("cancels a request immediately on editing and ignores its late answer", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { status: "ok"; titles: (typeof TITLE)[] }) => void;
    mockedTitles.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("hello"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    const signal = mockedTitles.mock.calls[0]?.[1]?.signal;
    expect(hook.result.current.busy).toBe(true);
    act(() => hook.result.current.setText("m"));
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve({ status: "ok", titles: [TITLE] }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(hook.result.current.titles).toEqual([]);
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.busy).toBe(false);
    expect(mockedTitles).toHaveBeenCalledTimes(1);
  });

  it("does not search during incomplete checksum input", async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("deadbeef123"));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedTitles).not.toHaveBeenCalled();
    expect(hook.result.current.error).toBe("");
  });

  it("shows live checksum matches and selects the chosen record's checksums", async () => {
    vi.useFakeTimers();
    const first = match("First", { expectedComponents: [{ crc32: "deadbeef", md5: "1".repeat(32) }] });
    const second = match("Second", { expectedComponents: [{ crc32: "deadbeef", md5: "2".repeat(32) }] });
    mockedLookup.mockResolvedValue({ status: "ambiguous", matches: [first, second] });
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("DEADBEEF"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(hook.result.current.result).toBeUndefined();
    expect(hook.result.current.versions).toEqual([first, second]);
    act(() => hook.result.current.choose(second));
    expect(hook.result.current.result?.foundBy).toBe("checksum");
    expect(hook.result.current.result?.checks.checksums).toEqual({ crc32: "deadbeef", md5: "2".repeat(32) });
    expect(hook.result.current.result?.identification.matches).toEqual([second]);
  });

  it("cancels delayed searches on clear and unmount", async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useRomLookup(MESSAGES));
    act(() => hook.result.current.setText("hello"));
    act(() => hook.result.current.clear());
    await act(() => vi.advanceTimersByTimeAsync(500));
    act(() => hook.result.current.setText("world"));
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(mockedTitles).not.toHaveBeenCalled();
  });

  it("rejects hex text of no known checksum length instead of searching it as a name", async () => {
    const hook = await search("abc123abc123");

    expect(hook.result.current.error).toBe("wrong length");
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedTitles).not.toHaveBeenCalled();
  });

  // Short hex text is a plausible game name, so it takes the name route.
  it("searches short hex text as a name", async () => {
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });

    await search("cafe");

    expect(mockedTitles).toHaveBeenCalledWith("cafe", expect.anything());
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("normalizes the pasted checksum and keeps it as the expectation", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });

    const hook = await search("  D7AE93DF ");

    expect(mockedLookup).toHaveBeenCalledWith({ checksums: { crc32: "d7ae93df" } }, expect.anything());
    expect(hook.result.current.result).toBeUndefined();
    const choice = hook.result.current.versions[0];
    if (!choice) throw new Error("The checksum result is missing");
    act(() => hook.result.current.choose(choice));
    expect(hook.result.current.result).toBeDefined();
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
    expect(unknown.result.current.error).toBe("No ROM has this checksum");
    expect(unknown.result.current.result).toBeUndefined();

    mockedLookup.mockResolvedValue({ matches: [], status: "unavailable" });
    const unavailable = await search("deadbeef");
    expect(unavailable.result.current.error).toBe("checksum data not available");
    expect(unavailable.result.current.result).toBeUndefined();
  });

  it("appends the technical cause behind unavailable data", async () => {
    mockedLookup.mockResolvedValue({
      matches: [],
      status: "unavailable",
      unavailableReason: "ROM identify database request failed with HTTP 404",
    });

    const hook = await search("deadbeef");

    expect(hook.result.current.error).toContain("not available");
    expect(hook.result.current.error).toContain("HTTP 404");
  });

  it("reports a thrown lookup instead of staying busy", async () => {
    mockedLookup.mockRejectedValue(new Error("pack read failed"));

    const hook = await search("d7ae93df");

    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.error).toBe("pack read failed");
  });

  it("rejects a name shorter than two characters before searching", async () => {
    const hook = await search("m");

    expect(hook.result.current.error).toBe("too short");
    expect(mockedTitles).not.toHaveBeenCalled();
  });

  it("lists the titles a name search finds", async () => {
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });

    const hook = await search("hello");

    expect(mockedTitles).toHaveBeenCalledWith("hello", expect.objectContaining({ limit: Infinity }));
    expect(hook.result.current.titles).toEqual([TITLE]);
    expect(hook.result.current.result).toBeUndefined();
  });

  it("makes matches after the first 50 accessible and resets for a new search", async () => {
    const titles = Array.from({ length: 50 }, (_, index) => ({ ...TITLE, name: `Zelda ${index}` }));
    titles.push({ ...TITLE, name: "The Legend of Zelda" });
    mockedTitles.mockResolvedValue({ status: "ok", titles });
    const hook = await search("zelda");
    const localizer = createBrowserLocalizer();
    const view = render(createElement(RomSearch, { lookup: hook.result.current, localizer }));
    expect(view.queryByText("The Legend of Zelda")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /More/u }));
    expect(view.getByText("The Legend of Zelda")).toBeTruthy();
    expect(view.queryByRole("button", { name: /More/u })).toBeNull();
    view.rerender(
      createElement(RomSearch, {
        lookup: { ...hook.result.current, titles: [...titles] },
        localizer,
      }),
    );
    expect(view.queryByText("The Legend of Zelda")).toBeNull();
    expect(view.getByRole("button", { name: /More/u })).toBeTruthy();
  });

  it("separates an unknown name from unavailable data", async () => {
    mockedTitles.mockResolvedValue({ status: "ok", titles: [] });
    const unknown = await search("hello");
    expect(unknown.result.current.error).toBe("No game has that name");

    mockedTitles.mockResolvedValue({ status: "unavailable", unavailableReason: "HTTP 404" });
    const unavailable = await search("hello");
    expect(unavailable.result.current.error).toBe("name data not available HTTP 404");
    expect(unavailable.result.current.titles).toEqual([]);
  });

  it("shows a title's only release for checksum selection, ignoring sequels", async () => {
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });
    mockedByName.mockResolvedValue({
      matches: [match("Hello World 2 (USA)"), match("Hello World (USA)")],
      status: "matched",
    });
    const hook = await search("hello");

    await act(async () => {
      await hook.result.current.chooseTitle(TITLE);
    });

    expect(mockedByName).toHaveBeenCalledWith("test-system", "Hello World", expect.anything());
    expect(hook.result.current.result).toBeUndefined();
    expect(hook.result.current.versions).toEqual([match("Hello World (USA)")]);
    expect(hook.result.current.titles).toEqual([TITLE]);
    expect(hook.result.current.title).toEqual(TITLE);
  });

  // The pack search ranks every superstring of the title too, so the sequel
  // MUST be dropped: only records of exactly the chosen title are releases.
  it("lists a title's releases, not its sequels, and keeps the titles behind them", async () => {
    mockedTitles.mockResolvedValue({ status: "ok", titles: [TITLE] });
    const usa = match("Hello World (USA)", {
      expectedComponents: [{ crc32: "d7ae93df", size: 1024 }],
      region: "USA",
    });
    const europe = match("Hello World (Europe)", { region: "Europe" });
    const sequel = match("Hello World 2 (USA)", { region: "USA" });
    mockedByName.mockResolvedValue({ matches: [sequel, usa, europe], status: "matched" });
    const hook = await search("hello");

    await act(async () => {
      await hook.result.current.chooseTitle(TITLE);
    });
    expect(hook.result.current.title).toEqual(TITLE);
    expect(hook.result.current.versions).toEqual([usa, europe]);
    expect(hook.result.current.result).toBeUndefined();

    act(() => hook.result.current.leaveTitle());
    expect(hook.result.current.title).toBeUndefined();
    expect(hook.result.current.versions).toEqual([]);
    expect(hook.result.current.titles).toEqual([TITLE]);

    act(() => hook.result.current.choose(usa));
    expect(hook.result.current.result?.checks).toEqual({ checksums: { crc32: "d7ae93df" }, size: 1024 });
    expect(hook.result.current.titles).toEqual([]);
  });

  it("keeps different checksums as release choices and excludes numeral aliases", async () => {
    const title = { ...TITLE, name: "The Legend IV" };
    const first = match("Legend IV, The (USA)", { expectedComponents: [{ crc32: "11111111" }] });
    const second = match("The Legend IV (Europe)", { expectedComponents: [{ crc32: "22222222" }] });
    const alias = match("The Legend 4 (USA)", { expectedComponents: [{ crc32: "33333333" }] });
    mockedTitles.mockResolvedValue({ status: "ok", titles: [title] });
    mockedByName.mockResolvedValue({ matches: [first, second, alias], status: "matched" });
    const hook = await search("legend 4");
    await act(async () => {
      await hook.result.current.chooseTitle(title);
    });
    expect(hook.result.current.versions).toEqual([first, second]);
    act(() => hook.result.current.choose(second));
    expect(hook.result.current.result?.checks.checksums).toEqual({ crc32: "22222222" });
  });

  it("clears the text, the lists, and the result together", async () => {
    mockedLookup.mockResolvedValue({ matches: [match("Hello World (USA)")], status: "matched" });
    const hook = await search("d7ae93df");
    expect(hook.result.current.result).toBeUndefined();
    const choice = hook.result.current.versions[0];
    if (!choice) throw new Error("The checksum result is missing");
    act(() => hook.result.current.choose(choice));
    expect(hook.result.current.result).toBeDefined();

    act(() => hook.result.current.clear());

    expect(hook.result.current.text).toBe("");
    expect(hook.result.current.result).toBeUndefined();
    expect(hook.result.current.titles).toEqual([]);
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
