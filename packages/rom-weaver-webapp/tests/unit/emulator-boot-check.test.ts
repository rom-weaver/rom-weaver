import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBootFrame,
  sampleBootFrames,
  summarizeFrameColors,
} from "../../src/public/react/components/emulator-boot-check.ts";

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

describe("sampleBootFrames", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const FLAT = 0;
  const PICTURE = 1;
  const png = (kind: number) => new Uint8Array([...PNG, kind]);
  // The last byte of the fake PNG picks the decoded frame.
  const decode = async (bytes: Uint8Array) =>
    bytes.at(-1) === PICTURE ? frame(0x000000, 0xffffff, 2000) : frame(0x000000);

  const player = (screens: Uint8Array[], { frames = 120, failedToStart = false } = {}) => {
    let shot = 0;
    const screenshot = vi.fn(async () => screens[Math.min(shot++, screens.length - 1)] as Uint8Array);
    return { emulator: { failedToStart, gameManager: { getFrameNum: () => frames, screenshot } }, screenshot };
  };

  const fast = { minFrames: 60, pollIntervalMs: 5, sampleIntervalMs: 5 };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps sampling past flat frames and boots on the first picture", async () => {
    const { emulator, screenshot } = player([png(FLAT), png(FLAT), png(PICTURE), png(FLAT)]);
    const outcome = await sampleBootFrames({
      ...fast,
      deadline: Date.now() + 2_000,
      decode,
      emulatorOf: () => emulator,
    });
    expect(outcome).toMatchObject({ samples: 3, status: "boots" });
    expect(screenshot).toHaveBeenCalledTimes(3);
  });

  it("reports blank only when every frame until the deadline is flat", async () => {
    const { emulator, screenshot } = player([png(FLAT)]);
    const outcome = await sampleBootFrames({ ...fast, deadline: Date.now() + 150, decode, emulatorOf: () => emulator });
    expect(outcome).toMatchObject({ reason: "blank-frame", status: "blank" });
    expect(screenshot.mock.calls.length).toBeGreaterThan(1);
    expect(outcome.status === "blank" && outcome.samples).toBe(screenshot.mock.calls.length);
  });

  it("reports a time-out, not a blank, when the core never draws enough frames", async () => {
    const { emulator, screenshot } = player([png(PICTURE)], { frames: 4 });
    const outcome = await sampleBootFrames({ ...fast, deadline: Date.now() + 80, decode, emulatorOf: () => emulator });
    expect(outcome).toEqual({ frames: 4, loaded: true, status: "timeout" });
    expect(screenshot).not.toHaveBeenCalled();
  });

  it("reports a time-out when the player never loads", async () => {
    const outcome = await sampleBootFrames({ ...fast, deadline: Date.now() + 50, decode, emulatorOf: () => undefined });
    expect(outcome).toEqual({ frames: 0, loaded: false, status: "timeout" });
  });

  it("reports blank when EmulatorJS fails to start", async () => {
    const { emulator } = player([png(PICTURE)], { failedToStart: true, frames: 0 });
    const outcome = await sampleBootFrames({
      ...fast,
      deadline: Date.now() + 1_000,
      decode,
      emulatorOf: () => emulator,
    });
    expect(outcome).toMatchObject({ reason: "failed-to-start", status: "blank" });
  });

  it("reports an error when the capture is not a PNG", async () => {
    const { emulator } = player([new Uint8Array([1, 2, 3])]);
    const outcome = await sampleBootFrames({
      ...fast,
      deadline: Date.now() + 1_000,
      decode,
      emulatorOf: () => emulator,
    });
    expect(outcome).toMatchObject({ detail: "The captured frame is not a PNG.", status: "error" });
  });

  it("gives a capture a minimum budget when the frames arrive at the deadline", async () => {
    const emulator = {
      gameManager: {
        getFrameNum: () => 120,
        screenshot: () => new Promise<Uint8Array>((resolve) => setTimeout(() => resolve(png(PICTURE)), 40)),
      },
    };
    const outcome = await sampleBootFrames({
      ...fast,
      deadline: Date.now() + 5,
      decode,
      emulatorOf: () => emulator,
      minCaptureMs: 500,
    });
    expect(outcome.status).toBe("boots");
  });

  it("clears the capture timer once the capture wins", async () => {
    vi.useFakeTimers();
    const { emulator } = player([png(PICTURE)]);
    const outcome = await sampleBootFrames({
      ...fast,
      deadline: Date.now() + 60_000,
      decode,
      emulatorOf: () => emulator,
    });
    expect(outcome.status).toBe("boots");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with AbortError and leaves no timer when cancelled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = sampleBootFrames({
      ...fast,
      deadline: Date.now() + 60_000,
      decode,
      emulatorOf: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
