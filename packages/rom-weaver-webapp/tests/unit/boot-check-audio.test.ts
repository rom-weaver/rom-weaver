import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareBootCheckAudioContext,
  releaseBootCheckAudioContext,
  restoreBootCheckAudioContext,
  takeBootCheckAudioContext,
} from "../../src/public/react/boot-check-audio.ts";

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  resumes = 0;
  constructor() {
    FakeAudioContext.created.push(this);
  }
  resume() {
    this.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

const asContext = (context: FakeAudioContext) => context as unknown as AudioContext;

beforeEach(() => {
  FakeAudioContext.created = [];
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
  releaseBootCheckAudioContext();
});

afterEach(() => {
  releaseBootCheckAudioContext();
  vi.unstubAllGlobals();
});

describe("boot check audio context", () => {
  it("gives nothing when no click armed a check", () => {
    expect(takeBootCheckAudioContext()).toBeNull();
    expect(FakeAudioContext.created).toHaveLength(0);
  });

  it("hands the click's running context to one check only", () => {
    prepareBootCheckAudioContext();
    const [created] = FakeAudioContext.created;
    expect(created?.state).toBe("running");
    expect(takeBootCheckAudioContext()).toEqual({ context: created });
    expect(takeBootCheckAudioContext()).toBeNull();
  });

  it("keeps the click's context when a queued Apply prepares again", () => {
    prepareBootCheckAudioContext();
    prepareBootCheckAudioContext();
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(FakeAudioContext.created[0]?.resumes).toBe(2);
  });

  it("never reuses a closed context after tick, untick, tick", () => {
    prepareBootCheckAudioContext();
    const first = FakeAudioContext.created[0];
    releaseBootCheckAudioContext();
    expect(first?.state).toBe("closed");
    expect(takeBootCheckAudioContext()).toBeNull();
    prepareBootCheckAudioContext();
    const taken = takeBootCheckAudioContext();
    expect(taken?.context).not.toBe(first);
    expect(taken?.context?.state).toBe("running");
  });

  it("replaces a pending context that was closed elsewhere", () => {
    prepareBootCheckAudioContext();
    const first = FakeAudioContext.created[0];
    if (first) first.state = "closed";
    prepareBootCheckAudioContext();
    expect(FakeAudioContext.created).toHaveLength(2);
    expect(takeBootCheckAudioContext()?.context).toBe(FakeAudioContext.created[1]);
  });

  it("re-arms a cancelled check and keeps a context no player used", () => {
    prepareBootCheckAudioContext();
    const taken = takeBootCheckAudioContext();
    restoreBootCheckAudioContext(taken?.context ?? null, true);
    expect(takeBootCheckAudioContext()).toEqual({ context: taken?.context });
  });

  it("re-arms a cancelled check but closes a context a player used", () => {
    prepareBootCheckAudioContext();
    const used = FakeAudioContext.created[0];
    takeBootCheckAudioContext();
    restoreBootCheckAudioContext(used ? asContext(used) : null, false);
    expect(used?.state).toBe("closed");
    expect(takeBootCheckAudioContext()).toEqual({ context: null });
  });

  it("disarms and closes the context when Apply fails or the option goes off", () => {
    prepareBootCheckAudioContext();
    releaseBootCheckAudioContext();
    expect(FakeAudioContext.created[0]?.state).toBe("closed");
    expect(takeBootCheckAudioContext()).toBeNull();
  });

  it("still arms a check when the browser has no Web Audio", () => {
    vi.stubGlobal("window", {});
    prepareBootCheckAudioContext();
    expect(takeBootCheckAudioContext()).toEqual({ context: null });
  });
});
