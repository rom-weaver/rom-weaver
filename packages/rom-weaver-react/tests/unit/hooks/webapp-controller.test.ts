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

  it("hides beta workflow views until enabled", () => {
    const controller = createController();
    expect(controller.selectView("trim")).toBe("patcher");
    expect(controller.getState().currentView).toBe("patcher");

    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.selectView("trim")).toBe("trim");
    expect(controller.getState().currentView).toBe("trim");

    controller.updateDraftSetting("betaToolsEnabled", false);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.getState().currentView).toBe("patcher");
  });

  it("falls back from a beta route in the initial hash", () => {
    window.location.hash = "#/tools";
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.hash).toBe("#/apply");
  });

  it("carries the bundle-author hash segment through routing", () => {
    // A bare deep link resolves to the Weave tab and normalizes to the
    // router's shape with the mode segment preserved.
    window.location.hash = "#bundle-author";
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.hash).toBe("#/apply/bundle-author");
    // The mode segment belongs to the apply form: navigating away drops it,
    // returning does not resurrect it.
    controller.selectView("creator");
    expect(window.location.hash).toBe("#/create");
    controller.selectView("patcher");
    expect(window.location.hash).toBe("#/apply");
  });

  it("keeps the routed bundle-author deep link on the weave tab", () => {
    window.location.hash = "#/apply/bundle-author";
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.hash).toBe("#/apply/bundle-author");
  });

  it("routes and tracks the tools workflow", () => {
    const controller = createController();
    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.selectView("tools")).toBe("tools");
    expect(window.location.hash).toBe("#/tools");
    controller.setToolsSessionState(true);
    expect(controller.getState().toolsSession.active).toBe(true);
  });

  it("does not notify subscribers when the tools session state is unchanged", () => {
    const controller = createController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setToolsSessionState(false);
    expect(listener).not.toHaveBeenCalled();
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
