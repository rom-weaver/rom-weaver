// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDefaultSettings,
  LOCAL_STORAGE_SETTINGS_ID,
  serializeSettingsForStorage,
  type SettingsState,
} from "../../src/webapp/settings/settings-state.ts";
import { createWebappRootController } from "../../src/webapp/webapp-controller.ts";

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

type Storage = ReturnType<typeof createStorage>;

// Writes what another tab would have persisted. A settings object equal to the defaults
// serializes to null, which is the schema's way of storing nothing at all.
const persistExternalSettings = (storage: Storage, changes: Partial<SettingsState>) => {
  const serialized = serializeSettingsForStorage({ ...getDefaultSettings(), ...changes });
  if (serialized === null) storage.removeItem(LOCAL_STORAGE_SETTINGS_ID);
  else storage.setItem(LOCAL_STORAGE_SETTINGS_ID, serialized);
};

const createController = ({
  onConfirmViewLeave,
  onCreatorViewRequested = vi.fn(() => true),
  storage = createStorage(),
}: {
  onConfirmViewLeave?: (context: { currentView: string; nextView: string }) => boolean;
  onCreatorViewRequested?: () => boolean;
  storage?: Storage;
} = {}) =>
  createWebappRootController({
    onApplySettings: vi.fn(),
    onConfirmViewLeave,
    onCreatorViewRequested,
    onFocusField: vi.fn(),
    onLocalizationChange: vi.fn(),
    storage,
  });

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("hasDraftSettingsChanges", () => {
  it("is false for an untouched draft and true once a field differs", () => {
    const controller = createController();

    expect(controller.hasDraftSettingsChanges()).toBe(false);

    controller.updateDraftSetting("fixChecksum", !getDefaultSettings().fixChecksum);

    expect(controller.hasDraftSettingsChanges()).toBe(true);
  });

  it("treats a numeric field retyped as a string with the same value as unchanged", () => {
    const controller = createController();
    const blockSize = getDefaultSettings().rvzBlockSize;

    controller.updateDraftSetting("rvzBlockSize", String(blockSize));

    expect(controller.getState().draftSettings.rvzBlockSize).toBe(String(blockSize));
    expect(controller.hasDraftSettingsChanges()).toBe(false);
  });
});

describe("reloadPersistedSettings", () => {
  it("returns the current settings unchanged when storage holds the same values", () => {
    const storage = createStorage();
    const controller = createController({ storage });
    const before = controller.getState().settings;

    expect(controller.reloadPersistedSettings()).toBe(before);
  });

  it("adopts the persisted settings wholesale when the draft is untouched", () => {
    const storage = createStorage();
    const controller = createController({ storage });
    persistExternalSettings(storage, { fixChecksum: !getDefaultSettings().fixChecksum });

    controller.reloadPersistedSettings();

    const state = controller.getState();
    expect(state.settings.fixChecksum).toBe(!getDefaultSettings().fixChecksum);
    expect(state.draftSettings.fixChecksum).toBe(state.settings.fixChecksum);
  });

  it("keeps the edited draft field while taking every other one from storage", () => {
    const storage = createStorage();
    const controller = createController({ storage });
    controller.updateDraftSetting("rvzBlockSize", "262144");
    persistExternalSettings(storage, { fixChecksum: !getDefaultSettings().fixChecksum, rvzBlockSize: 524288 });

    controller.reloadPersistedSettings();

    const state = controller.getState();
    expect(state.settings.rvzBlockSize).toBe(524288);
    expect(state.settings.fixChecksum).toBe(!getDefaultSettings().fixChecksum);
    // The field the user was editing survives the reload; every untouched one follows storage.
    expect(state.draftSettings.rvzBlockSize).toBe("262144");
    expect(state.draftSettings.fixChecksum).toBe(state.settings.fixChecksum);
  });
});

describe("selectView with a leave guard", () => {
  it("keeps the current view when the guard refuses", () => {
    const onConfirmViewLeave = vi.fn(() => false);
    const controller = createController({ onConfirmViewLeave });

    const view = controller.selectView("docs");

    expect(view).toBe("patcher");
    expect(controller.getState().currentView).toBe("patcher");
    expect(onConfirmViewLeave).toHaveBeenCalledWith({ currentView: "patcher", nextView: "docs" });
    expect(window.location.pathname).toBe("/apply");
  });

  it("moves on when the guard agrees", () => {
    const onConfirmViewLeave = vi.fn(() => true);
    const controller = createController({ onConfirmViewLeave });

    expect(controller.selectView("docs")).toBe("docs");
    expect(controller.getState().currentView).toBe("docs");
  });

  it("does not ask the guard when the view is unchanged", () => {
    const onConfirmViewLeave = vi.fn(() => false);
    const controller = createController({ onConfirmViewLeave });

    expect(controller.selectView("patcher")).toBe("patcher");
    expect(onConfirmViewLeave).not.toHaveBeenCalled();
  });

  it("falls back to the default view when the creator cannot open", () => {
    const onCreatorViewRequested = vi.fn(() => false);
    const controller = createController({ onCreatorViewRequested });

    expect(controller.selectView("creator")).toBe("patcher");
    expect(onCreatorViewRequested).toHaveBeenCalledTimes(1);
  });
});
