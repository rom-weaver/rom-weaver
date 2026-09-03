// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BundleApplySession } from "../../../src/lib/bundle/bundle-session-model.ts";
import { mergeBundleMetaForIds, useBundleApplySession } from "../../../src/public/react/use-bundle-apply-session.ts";

const patch = (fileName: string) => ({ fileName, name: fileName });

const session = (overrides: Partial<BundleApplySession> = {}): BundleApplySession =>
  ({
    key: "https://example.test/bundle.json",
    warnings: [],
    entries: [
      {
        fileName: "first.ips",
        id: "bundle-first",
        name: "First patch",
        version: "1.0",
        author: "Author",
        description: "The first change",
        label: "main",
        optional: false,
        basis: "base",
        header: "strip",
      },
      {
        fileName: "second.ips",
        id: "bundle-second",
        optional: true,
      },
    ],
    chainEndpointChecks: {
      input: { checksums: { crc32: "1234abcd" } },
      output: { checksums: { sha1: "0123456789abcdef0123456789abcdef01234567" } },
    },
    outputDefaults: { name: "Bundle result.zip", header: "keep" },
    ...overrides,
  }) as BundleApplySession;

describe("mergeBundleMetaForIds", () => {
  it("merges updates without changing unrelated ids", () => {
    const merged = mergeBundleMetaForIds(
      new Map([
        ["first", { author: "A", version: "1" }],
        ["other", { name: "Other" }],
      ]),
      ["first", "new"],
      { description: "shared" },
    );
    expect(merged.get("first")).toEqual({ author: "A", version: "1", description: "shared" });
    expect(merged.get("new")).toEqual({ description: "shared" });
    expect(merged.get("other")).toEqual({ name: "Other" });
  });
});

describe("useBundleApplySession", () => {
  it("seeds matching patches, options, output defaults, and metadata", async () => {
    const setPatchOption = vi.fn().mockResolvedValue(undefined);
    const setDisplayFileName = vi.fn();
    const setOutputHeader = vi.fn();
    const seedPatchEnablement = vi.fn();
    const controllersRef = {
      current: {
        output: { setDisplayFileName, setOutputHeader },
        patchStack: {
          getState: () => ({ items: [{ progress: null }, { optionsDisabled: false }] }),
          setPatchOption,
        },
      },
    } as never;
    const { result } = renderHook(() =>
      useBundleApplySession({
        bundleSession: session(),
        controllersRef,
        getPatchIds: () => ["slot-1", "slot-2"],
        seedPatchEnablement,
      }),
    );
    const patches = [patch("first.ips"), patch("second.ips")];

    act(() => result.current.handleBundlePatchesChange(patches));
    await waitFor(() => expect(result.current.bundleDefaultsPending).toBe(false));

    expect(seedPatchEnablement).toHaveBeenCalledWith([
      { enabled: true, id: "slot-1" },
      { enabled: false, id: "slot-2" },
    ]);
    expect(result.current.bundleMetaById.get("slot-1")).toMatchObject({
      author: "Author",
      basis: "base",
      id: "bundle-first",
      name: "First patch",
    });
    expect(setPatchOption).toHaveBeenNthCalledWith(1, 0, {
      basis: "base",
      header: "strip",
      revalidate: false,
      validateInputChecksum: "1234abcd",
    });
    expect(setPatchOption).toHaveBeenNthCalledWith(2, 1, { revalidate: true });
    expect(setDisplayFileName).toHaveBeenCalledWith("Bundle result");
    expect(setOutputHeader).toHaveBeenCalledWith("keep");
    expect((patches[0] as { _generatedPatchName?: string })._generatedPatchName).toBeTruthy();

    act(() => result.current.updateBundleMeta("slot-1", { author: "New author" }));
    await waitFor(() => expect(result.current.bundleMetaById.get("slot-1")?.author).toBe("New author"));
    act(() => result.current.updateBundleMetaForIds(["slot-1", "slot-2"], { label: "all" }));
    await waitFor(() => expect(result.current.bundleMetaById.get("slot-2")?.label).toBe("all"));

    const foreign = patch("foreign.ips");
    act(() => result.current.handleBundlePatchesChange([foreign]));
    expect((foreign as { _generatedPatchName?: string })._generatedPatchName).toBeUndefined();
    expect(result.current.bundleDefaultsPending).toBe(false);
  });

  it("replays when the session arrives after the patch list", async () => {
    const seedPatchEnablement = vi.fn();
    const controllersRef = { current: { output: null, patchStack: null } } as never;
    const patches = [patch("first.ips"), patch("second.ips")];
    const { result, rerender } = renderHook(
      ({ bundleSession }: { bundleSession: BundleApplySession | null }) =>
        useBundleApplySession({
          bundleSession,
          controllersRef,
          getPatchIds: () => ["slot-1", "slot-2"],
          seedPatchEnablement,
        }),
      { initialProps: { bundleSession: null } },
    );

    act(() => result.current.handleBundlePatchesChange(patches));
    rerender({ bundleSession: session({ key: "https://example.test/late.json" }) });
    await waitFor(() => expect(seedPatchEnablement).toHaveBeenCalledOnce());
    expect(result.current.bundleMetaById.get("slot-1")?.id).toBe("bundle-first");
  });
});
