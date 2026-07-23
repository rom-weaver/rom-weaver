// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWebappRootController, readWorkflowViewFromPath } from "../../../src/webapp/webapp-controller.ts";

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
  window.history.replaceState({}, "", "/");
});

describe("createWebappRootController over the vanilla store", () => {
  it("starts on the default workflow view with seeded session state", () => {
    const state = createController().getState();
    expect(state.currentView).toBe("patcher");
    expect(state.settingsDialogOpen).toBe(false);
    expect(state.patcherSession.romFilePresent).toBe(false);
    expect(window.location.pathname).toBe("/weave");
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

  it("falls back from a disabled beta route in the initial path", () => {
    window.history.replaceState({}, "", "/tools");
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/weave");
  });

  it("loads the create workflow from its path", () => {
    window.history.replaceState({}, "", "/create");
    const controller = createController();
    expect(controller.getState().currentView).toBe("creator");
    expect(readWorkflowViewFromPath()).toBe("creator");
    expect(window.location.pathname).toBe("/create");
  });

  it("preserves a self-hosted subpath while switching workflows", () => {
    window.history.replaceState({}, "", "/rom-weaver/create/");
    const controller = createController();
    expect(controller.getState().currentView).toBe("creator");
    controller.selectView("patcher");
    expect(window.location.pathname).toBe("/rom-weaver/weave");
  });

  it("normalizes a static-host index page to its clean route", () => {
    window.history.replaceState({}, "", "/rom-weaver/weave/index.html");
    expect(readWorkflowViewFromPath()).toBe("patcher");
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/rom-weaver/weave");
  });

  it("preserves URL session parameters without emitting hash routes", () => {
    window.history.replaceState({}, "", "/weave?bundle=first-weave.zip");
    const controller = createController();
    controller.selectView("creator");
    expect(window.location.pathname).toBe("/create");
    expect(window.location.search).toBe("?bundle=first-weave.zip");
    expect(window.location.hash).toBe("");
  });

  it("does not preserve legacy hash routes", () => {
    window.history.replaceState({}, "", "/#/create");
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/weave");
    expect(window.location.hash).toBe("");
  });

  it("routes and tracks the tools workflow", () => {
    const controller = createController();
    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.selectView("tools")).toBe("tools");
    expect(window.location.pathname).toBe("/tools");
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

  it("commits and persists the bundle package selection from the output card", () => {
    const storage = createStorage();
    const controller = createWebappRootController({
      onApplySettings: vi.fn(),
      onCreatorViewRequested: vi.fn(() => true),
      onFocusField: vi.fn(),
      onLocalizationChange: vi.fn(),
      storage,
    });
    controller.setBundlePackage("zip:rom");
    expect(controller.getState().settings.bundlePackage).toBe("zip:rom");
    expect(controller.getState().draftSettings.bundlePackage).toBe("zip:rom");
    expect(JSON.parse(storage.getItem("rom-weaver-settings") ?? "{}").apply?.output?.bundlePackage).toBe("zip:rom");
    // An unknown package is rejected rather than persisted.
    controller.setBundlePackage("tar:rom");
    expect(controller.getState().settings.bundlePackage).toBe("zip:rom");
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
