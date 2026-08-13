// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("loadIdentifyPacks", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("loads the current index and addresses the selected pack by checksum", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/index.json")) {
        expect(init).toEqual({ cache: "no-cache" });
        return new Response(
          JSON.stringify({
            format: "rom-weaver-identify-system-pack-v1",
            systems: [
              {
                file: "sega-32x.pack",
                platform: "Sega 32X",
                rawBytes: 3,
                sha256: SHA256_ABC,
                slug: "sega-32x",
                source: "opengood",
              },
            ],
          }),
        );
      }

      expect(url.pathname).toMatch(/\/identify-data\/v1\/sega-32x\.pack$/);
      expect(url.searchParams.get("sha256")).toBe(SHA256_ABC);
      return new Response(new TextEncoder().encode("abc"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadIdentifyPacks } = await import("../../src/platform/browser/identify-packs.ts");
    const packs = await loadIdentifyPacks("game.32x");

    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ fileName: "sega-32x.pack", platform: "Sega 32X" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
