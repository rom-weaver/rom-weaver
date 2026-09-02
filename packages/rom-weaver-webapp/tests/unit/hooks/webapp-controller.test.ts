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

const createController = (storage = createStorage()) =>
  createWebappRootController({
    onApplySettings: vi.fn(),
    onCreatorViewRequested: vi.fn(() => true),
    onFocusField: vi.fn(),
    onLocalizationChange: vi.fn(),
    storage,
  });

// Exercises the controller through the hand-rolled store that replaced zustand: the public
// getState/subscribe/mutation surface must round-trip exactly as before.
beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("createWebappRootController over the vanilla store", () => {
  it("starts on the landing page with seeded session state", () => {
    const state = createController().getState();
    expect(state.currentView).toBe("home");
    expect(state.settingsDialogOpen).toBe(false);
    expect(state.patcherSession.romFilePresent).toBe(false);
    expect(window.location.pathname).toBe("/");
  });

  it("starts on the landing page from the site root instead of restoring a saved Test tab", () => {
    const storage = createStorage();
    storage.setItem("rom-weaver-active-view", "test");

    const controller = createWebappRootController({
      onApplySettings: vi.fn(),
      onCreatorViewRequested: vi.fn(() => true),
      onFocusField: vi.fn(),
      onLocalizationChange: vi.fn(),
      storage,
    });

    expect(controller.getState().currentView).toBe("home");
    expect(window.location.pathname).toBe("/");
  });

  it("can preserve a non-workflow path for an alternate app shell", () => {
    window.history.replaceState({}, "", "/missing");
    const controller = createWebappRootController({
      initialHistoryMode: "none",
      onApplySettings: vi.fn(),
      onCreatorViewRequested: vi.fn(() => true),
      onFocusField: vi.fn(),
      onLocalizationChange: vi.fn(),
      storage: createStorage(),
    });
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/missing");
  });

  it("hides beta workflow views until enabled", () => {
    const controller = createController();
    expect(controller.selectView("identify")).toBe("patcher");
    expect(controller.selectView("trim")).toBe("patcher");
    expect(controller.getState().currentView).toBe("patcher");

    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.selectView("trim")).toBe("trim");
    expect(controller.getState().currentView).toBe("trim");
    expect(controller.selectView("identify")).toBe("identify");
    expect(controller.getState().currentView).toBe("identify");

    controller.updateDraftSetting("betaToolsEnabled", false);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.getState().currentView).toBe("patcher");
  });

  it("falls back from a disabled beta route in the initial path", () => {
    window.history.replaceState({}, "", "/tools");
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/apply");
  });

  it("loads the create workflow from its path", () => {
    window.history.replaceState({}, "", "/create");
    const controller = createController();
    expect(controller.getState().currentView).toBe("creator");
    expect(readWorkflowViewFromPath()).toBe("creator");
    expect(window.location.pathname).toBe("/create");
  });

  it("loads the identify workflow from its path", () => {
    const storage = createStorage();
    window.history.replaceState({}, "", "/identify");
    const controller = createController(storage);
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/apply");

    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    window.history.replaceState({}, "", "/identify");
    const enabledController = createController(storage);
    expect(enabledController.getState().currentView).toBe("identify");
    expect(readWorkflowViewFromPath()).toBe("identify");
    expect(window.location.pathname).toBe("/identify");
  });

  it("routes the Test workflow", () => {
    window.history.replaceState({}, "", "/test");
    const controller = createController();

    expect(controller.getState().currentView).toBe("test");
    expect(readWorkflowViewFromPath()).toBe("test");
    expect(controller.selectView("patcher")).toBe("patcher");
    expect(window.location.pathname).toBe("/apply");
    expect(controller.selectView("test")).toBe("test");
    expect(window.location.pathname).toBe("/test");
  });

  it("resolves a candidate URL without changing the current browser path", () => {
    expect(readWorkflowViewFromPath("/docs/apply-rom-patches")).toBe("docs");
    expect(readWorkflowViewFromPath("/create")).toBe("creator");
    expect(readWorkflowViewFromPath("/identify")).toBe("identify");
    expect(window.location.pathname).toBe("/");
  });

  it("preserves a self-hosted subpath while switching workflows", () => {
    window.history.replaceState({}, "", "/rom-weaver/create/");
    const controller = createController();
    expect(controller.getState().currentView).toBe("creator");
    controller.selectView("patcher");
    expect(window.location.pathname).toBe("/rom-weaver/apply");
  });

  it("normalizes a static-host index page to its clean route", () => {
    window.history.replaceState({}, "", "/rom-weaver/weave/index.html");
    expect(readWorkflowViewFromPath()).toBe("patcher");
    const controller = createController();
    expect(controller.getState().currentView).toBe("patcher");
    expect(window.location.pathname).toBe("/rom-weaver/apply");
  });

  it("keeps nested docs routes and returns to the app root", () => {
    window.history.replaceState({}, "", "/rom-weaver/docs/apply-rom-patches");
    const controller = createController();
    expect(controller.getState().currentView).toBe("docs");
    expect(readWorkflowViewFromPath()).toBe("docs");
    expect(window.location.pathname).toBe("/rom-weaver/docs/apply-rom-patches");

    controller.selectView("creator");
    expect(window.location.pathname).toBe("/rom-weaver/create");
  });

  it("preserves URL session parameters without emitting hash routes", () => {
    window.history.replaceState({}, "", "/apply?bundle=first-weave.zip");
    const controller = createController();
    controller.selectView("creator");
    expect(window.location.pathname).toBe("/create");
    expect(window.location.search).toBe("?bundle=first-weave.zip");
    expect(window.location.hash).toBe("");
  });

  it("does not preserve legacy hash routes", () => {
    window.history.replaceState({}, "", "/#/create");
    const controller = createController();
    expect(controller.getState().currentView).toBe("home");
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
  });

  it("routes and tracks the PPF undo workflow", () => {
    const controller = createController();
    controller.updateDraftSetting("betaToolsEnabled", true);
    expect(controller.saveDraftSettings()).toBe(true);
    expect(controller.selectView("ppf-undo")).toBe("ppf-undo");
    expect(window.location.pathname).toBe("/ppf-undo");
    controller.setPpfUndoSessionState(true);
    expect(controller.getState().ppfUndoSession.active).toBe(true);
  });

  it("does not notify subscribers when the PPF undo session state is unchanged", () => {
    const controller = createController();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setPpfUndoSessionState(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("commits and persists a language change", () => {
    const controller = createController();
    controller.setLanguage("de");
    expect(controller.getState().settings.language).toBe("de");
    expect(controller.getState().draftSettings.language).toBe("de");
  });

  it("rejects a language with no shipped catalog", () => {
    const controller = createController();
    const before = controller.getState().settings.language;
    controller.setLanguage("fr");
    expect(controller.getState().settings.language).toBe(before);
  });

  it("commits and persists an accent change from the masthead picker", () => {
    const storage = createStorage();
    const controller = createWebappRootController({
      onApplySettings: vi.fn(),
      onCreatorViewRequested: vi.fn(() => true),
      onFocusField: vi.fn(),
      onLocalizationChange: vi.fn(),
      storage,
    });
    controller.setAccent("woad");
    expect(controller.getState().settings.accent).toBe("woad");
    expect(controller.getState().draftSettings.accent).toBe("woad");
    expect(JSON.parse(storage.getItem("rom-weaver-settings") ?? "{}").common?.accent).toBe("woad");
    // An unknown dye lot is rejected rather than persisted.
    controller.setAccent("chartreuse");
    expect(controller.getState().settings.accent).toBe("woad");
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

  it("resets transient page state without changing saved settings or the current view", () => {
    const controller = createController();
    controller.selectView("creator");
    controller.setCreatorModifiedState({});
    controller.setPatcherInputState([{}]);
    controller.setPatcherPatchState([{}]);
    controller.setPpfUndoSessionState(true);
    controller.setTrimSourceState({});
    controller.setStartupState("error", "failed");
    controller.openSettings();
    controller.updateDraftSetting("language", "de");

    controller.resetPage();

    const state = controller.getState();
    expect(state.currentView).toBe("creator");
    expect(state.creatorSession.modifiedFilePresent).toBe(false);
    expect(state.patcherSession).toEqual({
      outputCompression: "none",
      outputName: "",
      patchCount: 0,
      pendingDownloadFileName: null,
      romFilePresent: false,
    });
    expect(state.settingsDialogOpen).toBe(false);
    expect(state.draftSettings).toEqual(state.settings);
    expect(state.startup).toEqual({ message: "", status: "ready" });
    expect(state.ppfUndoSession.active).toBe(false);
    expect(state.trimSession.sourceFilePresent).toBe(false);
    expect(state.validation).toEqual({ invalidFields: [], messages: [] });
  });
});
