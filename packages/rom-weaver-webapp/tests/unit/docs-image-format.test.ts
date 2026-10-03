import { afterEach, describe, expect, it, vi } from "vitest";
import { detectDocsImageFormat } from "../../src/webapp/pwa/docs-image-format.ts";

afterEach(() => vi.unstubAllGlobals());

describe("documentation image format", () => {
  it.each([true, false])("uses the native image decoder when AVIF support is %s", async (supported) => {
    const image = {
      naturalWidth: supported ? 1 : 0,
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    Object.defineProperty(image, "src", {
      set: (src: string) => {
        expect(src).toMatch(/^data:image\/avif;base64,/u);
        queueMicrotask(() => {
          if (supported) image.onload?.();
          else image.onerror?.();
        });
      },
    });
    vi.stubGlobal(
      "Image",
      vi.fn(function () {
        return image;
      }),
    );
    expect(await detectDocsImageFormat()).toBe(supported ? "avif" : "webp");
  });
});
