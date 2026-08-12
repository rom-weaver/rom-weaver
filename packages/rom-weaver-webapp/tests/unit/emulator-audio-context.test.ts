// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeAllEmulatorAudioContexts,
  disposeEmulatorAudioContext,
  prepareEmulatorAudioContext,
  registerEmulatorStartRequestHandler,
  requestEmulatorStartFromUserAction,
} from "../../src/public/react/emulator-audio-context.ts";

type TestAudioBridge = {
  hasPrepared: (gameName: string) => boolean;
  takePrepared: (gameName: string, options?: AudioContextOptions) => AudioContext | null;
};

const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });
  readonly resume = vi.fn(async () => {
    this.state = "running";
  });
  readonly suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  readonly sampleRate: number;
  state: AudioContextState = "suspended";

  constructor(options?: AudioContextOptions) {
    this.sampleRate = options?.sampleRate || 44_100;
    contexts.push(this);
  }
}

const bridge = () => (window as typeof window & { __romWeaverEmulatorAudio: TestAudioBridge }).__romWeaverEmulatorAudio;

beforeEach(() => {
  contexts.length = 0;
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone) AppleWebKit Safari");
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("iPhone");
  vi.spyOn(window.navigator, "maxTouchPoints", "get").mockReturnValue(5);
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  disposeAllEmulatorAudioContexts();
  Reflect.deleteProperty(window.navigator, "audioSession");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("emulator audio context", () => {
  it("prepares a 48 kHz parent context for an iOS game", () => {
    expect(prepareEmulatorAudioContext("game-a")).toBe(true);

    expect(contexts).toHaveLength(1);
    expect(contexts[0].sampleRate).toBe(48_000);
    expect(contexts[0].resume).toHaveBeenCalledOnce();
    expect(bridge().hasPrepared("game-a")).toBe(true);
    expect(bridge().hasPrepared("game-b")).toBe(false);
  });

  it("uses the playback audio session so iOS silent mode does not mute the game", () => {
    const audioSession = { type: "ambient" };
    Object.defineProperty(window.navigator, "audioSession", { configurable: true, value: audioSession });

    expect(prepareEmulatorAudioContext("game-a")).toBe(true);

    expect(audioSession.type).toBe("playback");
  });

  it("lends the prepared context to EmulatorJS and closes it with the game", () => {
    prepareEmulatorAudioContext("game-a");

    const claimed = bridge().takePrepared("game-a", { sampleRate: 48_000 });

    expect(claimed).toBe(contexts[0]);
    expect(bridge().hasPrepared("game-a")).toBe(false);
    disposeEmulatorAudioContext("game-a");
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it("rejects a context with the wrong sample rate", () => {
    prepareEmulatorAudioContext("game-a");

    expect(bridge().takePrepared("game-a", { sampleRate: 44_100 })).toBeNull();
    expect(contexts[0].close).toHaveBeenCalledOnce();
  });

  it("suspends and resumes an interrupted context", async () => {
    prepareEmulatorAudioContext("game-a");
    bridge().takePrepared("game-a", { sampleRate: 48_000 });
    contexts[0].state = "interrupted";
    contexts[0].resume.mockClear();

    expect(prepareEmulatorAudioContext("game-a")).toBe(true);

    await vi.waitFor(() => {
      expect(contexts[0].suspend).toHaveBeenCalledOnce();
      expect(contexts[0].resume).toHaveBeenCalledOnce();
      expect(contexts[0].state).toBe("running");
    });
  });

  it("does not create a context outside Apple mobile WebKit", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 X11 Chrome Safari");
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
    vi.spyOn(window.navigator, "maxTouchPoints", "get").mockReturnValue(0);

    expect(prepareEmulatorAudioContext("game-a")).toBe(false);
    expect(contexts).toHaveLength(0);
  });

  it("routes a Test gesture to the mounted emulator", () => {
    const handler = vi.fn(() => true);
    const unregister = registerEmulatorStartRequestHandler(handler);

    expect(requestEmulatorStartFromUserAction("game-a")).toBe(true);
    expect(handler).toHaveBeenCalledWith("game-a");
    unregister();
    expect(requestEmulatorStartFromUserAction("game-a")).toBe(false);
  });
});
