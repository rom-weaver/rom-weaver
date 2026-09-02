// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyVitePageUpdateState, getPageUpdateState } from "../../src/webapp/page-update-state.ts";
import { createServiceWorkerCacheState } from "../../src/webapp/pwa/service-worker-cache-state.ts";
import { createWebappRootController } from "../../src/webapp/webapp-controller.ts";
import { createEmptyConfirmationDialogState } from "../../src/webapp/webapp-root-types.ts";
import type { WebappRootProps } from "../../src/webapp/webapp-root-types.ts";
import { resolveThreads, selectViewWithTransition, WebappRoot } from "../../src/webapp/webapp-root.tsx";
import { preloadWorkflowRoute } from "../../src/webapp/workflow-routes.tsx";

const mocks = vi.hoisted(() => ({
  queryOfflineReadyState: vi.fn(async () => null),
  requestEmulatorStartFromUserAction: vi.fn(),
  scheduleOfflineWarmup: vi.fn(() => () => undefined),
}));

vi.mock("../../src/public/react/emulator-audio-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/public/react/emulator-audio-context.ts")>()),
  requestEmulatorStartFromUserAction: mocks.requestEmulatorStartFromUserAction,
}));

vi.mock("../../src/webapp/pwa/offline-warmup-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/webapp/pwa/offline-warmup-client.ts")>();
  return {
    ...actual,
    queryOfflineReadyState: mocks.queryOfflineReadyState,
    scheduleOfflineWarmup: mocks.scheduleOfflineWarmup,
  };
});

// The changelog tab fetches release notes over the network; the dialog only needs it to mount.
vi.mock("../../src/webapp/components/changelog-panel.tsx", () => ({ ChangelogPanel: () => null }));

const noop = () => undefined;

type Actions = WebappRootProps["actions"];

const createActions = () => {
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const actions = new Proxy({} as Record<string, unknown>, {
    get: (_target, property: string) => {
      if (property === "onConfirmExternalNavigation") return async () => true;
      let handler = calls.get(property);
      if (!handler) {
        handler = vi.fn();
        calls.set(property, handler);
      }
      return handler;
    },
  }) as unknown as Actions;
  const called = (name: string) => {
    let handler = calls.get(name);
    if (!handler) {
      handler = vi.fn();
      calls.set(name, handler);
    }
    return handler;
  };
  return { actions, called };
};

const baseState = () => {
  const controller = createWebappRootController({
    onApplySettings: noop,
    onCreatorViewRequested: () => true,
    onFocusField: noop,
    onLocalizationChange: noop,
    storage: undefined,
  });
  return { ...controller.getState(), startup: { message: "", status: "ready" as const } };
};

const renderRoot = async ({
  currentView = "patcher" as WebappRootProps["state"]["currentView"],
  notFound = false,
  serviceWorkerStatus = null as WebappRootProps["serviceWorkerCache"]["serviceWorkerStatus"],
  settingsDialogOpen = false,
  updateReady = false,
}: {
  currentView?: WebappRootProps["state"]["currentView"];
  notFound?: boolean;
  serviceWorkerStatus?: WebappRootProps["serviceWorkerCache"]["serviceWorkerStatus"];
  settingsDialogOpen?: boolean;
  updateReady?: boolean;
} = {}) => {
  if (!notFound) await preloadWorkflowRoute(currentView);
  const { actions, called } = createActions();
  const view = render(
    <WebappRoot
      actions={actions}
      confirmationDialog={createEmptyConfirmationDialogState()}
      notFound={notFound}
      pageUpdate={getPageUpdateState({
        serviceWorkerCache: { updateReady },
        vite: createEmptyVitePageUpdateState(),
      })}
      serviceWorkerCache={{ ...createServiceWorkerCacheState(), serviceWorkerStatus, updateReady }}
      state={{ ...baseState(), currentView, settingsDialogOpen }}
      urlSession={null}
    />,
  );
  return { ...view, called };
};

const fileDragEvent = (type: string, target: EventTarget = document, files: File[] = []) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      dropEffect: "none",
      files,
      items: files.map((file) => ({ getAsFile: () => file, kind: "file" })),
      types: ["Files"],
    },
  });
  Object.defineProperty(event, "target", { value: target });
  return event;
};

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("resolveThreads", () => {
  it("keeps an explicit count and falls back for anything unusable", () => {
    expect(resolveThreads(6)).toBe(6);
    expect(resolveThreads("6")).toBe(6);
    expect(resolveThreads("auto")).toBeGreaterThanOrEqual(1);
    expect(resolveThreads(0)).toBeGreaterThanOrEqual(1);
    expect(resolveThreads(undefined)).toBeGreaterThanOrEqual(1);
  });
});

describe("selectViewWithTransition", () => {
  it("runs the selection", () => {
    const select = vi.fn();
    selectViewWithTransition(select);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("the workbench shell", () => {
  it("mounts the requested workflow panel and names the page for it", async () => {
    const { container } = await renderRoot();

    expect(container.querySelector("#panel-patcher")).not.toBeNull();
    expect(container.querySelector("#panel-patcher")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("#panel-creator")).toBeNull();
    expect(document.title).toContain("rom-weaver");
    expect(document.documentElement.dataset.betaToolsEnabled).toBeDefined();
  });

  it("renders the not-found workbench with links out and no workflow panels", async () => {
    const { container } = await renderRoot({ notFound: true });

    expect(container.querySelector(".not-found-page")).not.toBeNull();
    expect(container.querySelector(".not-found-home")?.getAttribute("href")).toBe("/apply");
    expect(container.querySelector("#panel-patcher")).toBeNull();
    expect(container.querySelector(".workbench")?.className).toContain("is-not-found");
  });

  it("routes a not-found tab click to a full page load", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { container } = await renderRoot({ notFound: true });

    fireEvent.click(container.querySelector('.dock-tab[data-mode="creator"]') as HTMLAnchorElement);

    expect(assign).toHaveBeenCalledWith("/create");
  });

  it("routes a not-found Bundles click to the Apply bundle-step page", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => undefined);
    const { container } = await renderRoot({ notFound: true });

    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-more-workflow="bundle"]') as HTMLButtonElement);

    expect(assign).toHaveBeenCalledWith("/apply#bundle");
  });
});

describe("tab selection", () => {
  it("asks the host to change view", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector('.dock-tab[data-mode="creator"]') as HTMLAnchorElement);

    expect(called("onSelectView")).toHaveBeenCalledWith("creator");
  });

  it("starts the emulator audio context from the Test tab's own click", async () => {
    const { container } = await renderRoot();

    fireEvent.click(container.querySelector('.dock-tab[data-mode="test"]') as HTMLAnchorElement);

    expect(mocks.requestEmulatorStartFromUserAction).toHaveBeenCalledTimes(1);
  });

  it("opens Apply and targets the bundle step from the More menu's Bundles entry", async () => {
    window.location.hash = "";
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-more-workflow="bundle"]') as HTMLButtonElement);

    expect(window.location.hash).toBe("#bundle");
    expect(called("onSelectView")).toHaveBeenCalledWith("patcher");
  });

  it("waits for the lazy Docs route before switching to it", async () => {
    const { called, container } = await renderRoot();

    // Docs lives under More on both layouts, not in the dock.
    expect(container.querySelector('.dock-tab[data-mode="docs"]')).toBeNull();
    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-more-workflow="docs"]') as HTMLButtonElement);
    expect(called("onSelectView")).not.toHaveBeenCalled();

    await waitFor(() => expect(called("onSelectView")).toHaveBeenCalledWith("docs"));
  });
});

describe("the unified dialog", () => {
  const openFromMore = (container: HTMLElement, name: string) => {
    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);
    const item = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((entry) =>
      entry.textContent?.includes(name),
    );
    fireEvent.click(item as HTMLElement);
  };

  it("opens on Status from the More menu", async () => {
    const { container } = await renderRoot();

    openFromMore(container, "Status");

    await waitFor(() => expect(container.querySelector("dialog.log-dlg")).not.toBeNull());
    expect(container.querySelector('[data-logtab="status"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("sends the Status control to the changelog while an update is waiting", async () => {
    const { container } = await renderRoot({ updateReady: true });

    openFromMore(container, "Status");

    await waitFor(() =>
      expect(container.querySelector('[data-logtab="changelog"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("opens on Storage and on Logs", async () => {
    const { container } = await renderRoot();

    openFromMore(container, "Storage");
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="storage"]')?.getAttribute("aria-selected")).toBe("true"),
    );

    openFromMore(container, "Logs");
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="logs"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("stages a settings draft when the panel gear opens it", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".workflow-panel-head button") as HTMLButtonElement);

    expect(called("onOpenSettings")).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="settings"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });

  it("resets the workflow from the panel head", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".workflow-panel-head .reset-btn") as HTMLButtonElement);

    expect(called("onReset")).toHaveBeenCalledTimes(1);
  });
});

describe("the update banner", () => {
  it("remembers a dismissal for this build", async () => {
    const { container } = await renderRoot({ updateReady: true });
    const banner = container.querySelector(".reveal.is-open .updates.update-ready");
    expect(banner).not.toBeNull();

    fireEvent.click(container.querySelector(".updates.update-ready .banner-x") as HTMLButtonElement);

    expect(container.querySelector(".reveal.is-open .updates.update-ready")).toBeNull();
    expect(window.localStorage.getItem("rom-weaver-update-dismissed-build")).toBeTruthy();
  });

  it("stays dismissed on the next mount of the same build", async () => {
    const first = await renderRoot({ updateReady: true });
    fireEvent.click(first.container.querySelector(".updates.update-ready .banner-x") as HTMLButtonElement);
    cleanup();

    const second = await renderRoot({ updateReady: true });

    expect(second.container.querySelector(".reveal.is-open .updates.update-ready")).toBeNull();
  });
});

describe("page-level drag and drop", () => {
  it("arms the page while a file is dragged over it", async () => {
    const { container } = await renderRoot();

    act(() => {
      document.dispatchEvent(fileDragEvent("dragover"));
    });

    expect(container.querySelector("#column")?.className).toContain("rw-page-dragging");
  });

  it("ignores a drag that carries no files", async () => {
    const { container } = await renderRoot();
    const event = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { items: [], types: ["text/plain"] } });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(container.querySelector("#column")?.className).not.toContain("rw-page-dragging");
  });

  it("claims a page drop and clears the armed state", async () => {
    const { container } = await renderRoot();
    const dropped = fileDragEvent("drop", document.body, [new File(["rom"], "game.sfc")]);

    act(() => {
      document.dispatchEvent(fileDragEvent("dragover"));
      document.dispatchEvent(dropped);
    });

    expect(dropped.defaultPrevented).toBe(true);
    await waitFor(() => expect(container.querySelector("#column")?.className).not.toContain("rw-page-dragging"));
  });

  it("leaves a drop inside a workflow drop zone to that zone", async () => {
    const { container } = await renderRoot();
    const zone = container.querySelector(".rw-app .drop");
    if (!zone) throw new Error("The apply workflow rendered no drop zone");
    const dropped = fileDragEvent("drop", zone, [new File(["rom"], "game.sfc")]);

    act(() => {
      document.dispatchEvent(dropped);
    });

    expect(dropped.defaultPrevented).toBe(false);
  });
});

describe("page metadata per view", () => {
  it("names the page for a view that has no SEO route of its own", async () => {
    await renderRoot({ currentView: "trim" });

    expect(document.title).toBe("rom-weaver - Trim");
  });

  it("uses the marketing title for a view that has one", async () => {
    await renderRoot({ currentView: "test" });

    expect(document.title).not.toBe("rom-weaver - Test");
    expect(document.title).toContain("rom-weaver");
  });
});

describe("entry animations", () => {
  it("locks an entry animation once it has played", async () => {
    const { container } = await renderRoot();
    const panel = container.querySelector("#panel-patcher") as HTMLElement;

    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "card-in" });
      panel.dispatchEvent(event);
    });

    expect(panel.style.animation).toBe("none");
  });

  it("leaves an animation it does not own alone", async () => {
    const { container } = await renderRoot();
    const panel = container.querySelector("#panel-patcher") as HTMLElement;

    act(() => {
      const event = new Event("animationend", { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "spin" });
      panel.dispatchEvent(event);
    });

    expect(panel.style.animation).toBe("");
  });
});

describe("offline warm-up progress", () => {
  it("paints the reported progress on the runtime chip and remembers readiness", async () => {
    const { container } = await renderRoot({ serviceWorkerStatus: "active" });
    const onProgress = mocks.scheduleOfflineWarmup.mock.calls.at(-1)?.[0]?.onProgress;
    if (!onProgress) throw new Error("The root scheduled no warm-up");

    act(() => {
      onProgress({ cachedBytes: 1, ready: true, totalBytes: 1 });
    });

    await waitFor(() => expect(container.querySelector(".sub-status")?.getAttribute("data-sw")).toBe("active"));
    expect(window.localStorage.getItem("rom-weaver-offline-ready")).toBe("true");
  });
});

describe("the settings draft flow", () => {
  const openSettings = (container: HTMLElement) => {
    fireEvent.click(container.querySelector(".workflow-panel-head button") as HTMLButtonElement);
    return waitFor(() => {
      const dialog = container.querySelector("dialog.log-dlg");
      if (!dialog) throw new Error("The settings dialog never opened");
      return dialog as HTMLDialogElement;
    });
  };

  it("re-stages the draft when the dialog's own Settings tab is chosen", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    await openSettings(container);
    const before = called("onOpenSettings").mock.calls.length;

    fireEvent.click(container.querySelector('[data-logtab="logs"]') as HTMLButtonElement);
    fireEvent.click(container.querySelector('[data-logtab="settings"]') as HTMLButtonElement);

    expect(called("onOpenSettings").mock.calls.length).toBe(before + 1);
  });

  it("runs the discard flow instead of closing the dialog outright", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    const dialog = await openSettings(container);

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(called("onCloseSettings")).toHaveBeenCalledTimes(1);
    // The dialog stays up until the controller actually clears the draft.
    expect(container.querySelector("dialog.log-dlg")).not.toBeNull();
  });

  it("closes the dialog straight away when no draft is staged", async () => {
    const { called, container } = await renderRoot();
    fireEvent.click(container.querySelector(".desktop-more .mode-more") as HTMLButtonElement);
    const status = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((entry) =>
      entry.textContent?.includes("Status"),
    );
    fireEvent.click(status as HTMLElement);
    const dialog = await waitFor(() => container.querySelector("dialog.log-dlg") as HTMLDialogElement);

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(called("onCloseSettings")).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector("dialog.log-dlg")).toBeNull());
  });

  it("saves the draft from the dialog's Save control", async () => {
    const { called, container } = await renderRoot({ settingsDialogOpen: true });
    await openSettings(container);

    const save = await waitFor(() => {
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (entry) => entry.textContent?.trim() === "Save",
      );
      if (!button) throw new Error("The settings tab rendered no Save control");
      return button;
    });
    fireEvent.click(save);

    expect(called("onSaveClose")).toHaveBeenCalledTimes(1);
  });

  it("deep links the thread count into the Threads setting", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".masthead-threads") as HTMLButtonElement);

    expect(called("onOpenSettings")).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector('[data-logtab="settings"]')?.getAttribute("aria-selected")).toBe("true"),
    );
  });
});

describe("idle preloading", () => {
  it("warms the dialogs without the ROM runtime on a guide page", async () => {
    const idle = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);

    await renderRoot({ currentView: "docs" });

    expect(idle).toHaveBeenCalledTimes(1);
    expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: 2000 });
    const scheduled = idle.mock.calls[0]?.[0];
    if (!scheduled) throw new Error("requestIdleCallback must have been scheduled");
    act(() => {
      (scheduled as () => void)();
    });
    vi.unstubAllGlobals();
  });

  it("falls back to a timeout when the browser has no idle callback", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");

    await renderRoot({ currentView: "docs" });

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 0)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("host ingest", () => {
  it("logs a path it cannot resolve instead of throwing", async () => {
    const { ingest } = await import("../../src/webapp/host-ingest.ts");
    await renderRoot();

    expect(() => ingest(["/work/rom-weaver-imports/missing.sfc"])).not.toThrow();
  });
});

describe("the mobile More settings row", () => {
  it("opens the settings tab from the phone menu", async () => {
    const { called, container } = await renderRoot();

    fireEvent.click(container.querySelector(".mobile-more .dock-action") as HTMLButtonElement);
    const settings = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((entry) =>
      entry.textContent?.includes("Settings"),
    );
    fireEvent.click(settings as HTMLElement);

    expect(called("onOpenSettings")).toHaveBeenCalledTimes(1);
  });
});
