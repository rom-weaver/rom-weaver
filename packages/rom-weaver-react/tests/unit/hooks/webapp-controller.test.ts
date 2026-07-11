// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebappRootController } from "../../../src/webapp/webapp-controller.ts";

const createStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
};

const createController = () =>
  createWebappRootController({
    onApplySettings: vi.fn(),
    onCreatorViewRequested: vi.fn(() => true),
    onFocusField: vi.fn(),
    onLocalizationChange: vi.fn(),
    storage: createStorage(),
  });

// Exercises the controller through the hand-rolled store that replaced zustand: the public
// getState/subscribe/mutation surface must round-trip exactly as before.
beforeEach(() => {
  window.location.hash = "";
});

describe("createWebappRootController over the vanilla store", () => {
  it("starts on the default workflow view with seeded session state", () => {
    const state = createController().getState();
    expect(state.currentView).toBe("patcher");
    expect(state.settingsDialogOpen).toBe(false);
    expect(state.patcherSession.romFilePresent).toBe(false);
  });

  it("commits a view change visible through getState", () => {
    const controller = createController();
    expect(controller.selectView("trim")).toBe("trim");
    expect(controller.getState().currentView).toBe("trim");
  });

  it("commits and persists a language change", () => {
    const controller = createController();
    controller.setLanguage("de");
    expect(controller.getState().settings.language).toBe("de");
    expect(controller.getState().draftSettings.language).toBe("de");
  });

  it("notifies subscribers on a state mutation and stops after unsubscribe", () => {
    const controller = createController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    controller.setStartupState("ready", "done");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getState().startup).toEqual({ message: "done", status: "ready" });

    unsubscribe();
    controller.setStartupState("error", "boom");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("merges partial session updates without dropping sibling fields", () => {
    const controller = createController();
    controller.setPatcherInputState([{}, {}]);
    controller.setPatcherPatchState([{}]);
    const session = controller.getState().patcherSession;
    expect(session.romFilePresent).toBe(true);
    expect(session.patchCount).toBe(1);
  });
});
