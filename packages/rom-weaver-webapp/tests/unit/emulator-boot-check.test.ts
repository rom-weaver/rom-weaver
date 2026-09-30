import { describe, expect, it } from "vitest";
import { isBootFrame, summarizeFrameColors } from "../../src/public/react/components/emulator-boot-check.ts";

const WIDTH = 256;
const HEIGHT = 240;

/** An RGBA frame filled with `background`, with `count` pixels set to `foreground`. */
const frame = (background: number, foreground = background, count = 0) => {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const rgb = pixel < count ? foreground : background;
    data.set([(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, 0xff], pixel * 4);
  }
  return { data, height: HEIGHT, width: WIDTH };
};

describe("summarizeFrameColors", () => {
  it("names the dominant colour and the share of other pixels", () => {
    const summary = summarizeFrameColors(frame(0x000000, 0xffffff, 6144));
    expect(summary.distinct).toBe(2);
    expect(summary.dominant).toBe(0x000000);
    expect(summary.minorityRatio).toBeCloseTo(0.1, 5);
  });

  it("ignores alpha when it counts colours", () => {
    const image = frame(0x123456);
    image.data[3] = 0;
    expect(summarizeFrameColors(image).distinct).toBe(1);
  });

  it("reports an empty frame as having no colours", () => {
    expect(summarizeFrameColors({ data: new Uint8ClampedArray(), height: 0, width: 0 })).toEqual({
      distinct: 0,
      dominant: 0,
      minorityRatio: 0,
    });
  });
});

describe("isBootFrame", () => {
  it("accepts a frame with a picture on a flat background", () => {
    expect(isBootFrame(summarizeFrameColors(frame(0x000000, 0xffffff, 2000)))).toBe(true);
  });

  it("rejects a single flat colour", () => {
    expect(isBootFrame(summarizeFrameColors(frame(0x000000)))).toBe(false);
    expect(isBootFrame(summarizeFrameColors(frame(0x0000ff)))).toBe(false);
  });

  it("rejects a few stray pixels at or under 0.1% of the frame", () => {
    // 61 of 61,440 pixels is just under 0.1%.
    expect(isBootFrame(summarizeFrameColors(frame(0x000000, 0xffffff, 61)))).toBe(false);
    expect(isBootFrame(summarizeFrameColors(frame(0x000000, 0xffffff, 62)))).toBe(true);
  });
});
