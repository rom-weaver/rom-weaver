import type { Eruda } from "eruda";

(() => {
  const LOCAL_STORAGE_SETTINGS_ID = "rom-weaver-settings";
  const SETTINGS_STORAGE_VERSION = 5;
  const ERUDA_TOOLS = ["console", "elements", "network", "resources", "sources", "info", "settings"];
  const MOBILE_ERUDA_QUERY = "(pointer: coarse), (max-width: 767px)";

  let devToolsEnabled = false;
  let erudaEnabled = false;
  let erudaScriptLoading = false;
  let erudaLoadPromise: Promise<void> | null = null;
  let openErudaWhenReady = false;
  let erudaPanelOpen = false;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const readStoredErudaEnabled = (rawSettings: string | null): boolean => {
    if (!rawSettings) return false;
    const settings = JSON.parse(rawSettings) as unknown;
    if (!isRecord(settings) || settings.version !== SETTINGS_STORAGE_VERSION) return false;
    const commonSettings = isRecord(settings.common) ? settings.common : null;
    return (commonSettings?.devTools ?? commonSettings?.mobileDevTools) === true;
  };

  const readStoredErudaSetting = (): boolean => {
    try {
      if (typeof localStorage === "undefined") return false;
      const rawSettings = localStorage.getItem(LOCAL_STORAGE_SETTINGS_ID);
      return readStoredErudaEnabled(rawSettings);
    } catch (_err) {
      return false;
    }
  };
  const mobileErudaMedia = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_ERUDA_QUERY) : null;
  const canUseEruda = () =>
    mobileErudaMedia?.matches === true ||
    (mobileErudaMedia === null && typeof window.innerWidth === "number" && window.innerWidth <= 767);
  const setErudaPanelOpen = (open: boolean) => {
    erudaPanelOpen = open;
    window.ROM_WEAVER_ERUDA_PANEL_OPEN = open;
    document.documentElement.dataset.mobileDevtoolsOpen = open ? "true" : "false";
    window.dispatchEvent(new CustomEvent("rom-weaver:mobile-devtools-state", { detail: { open } }));
  };
  const initEruda = () => {
    if (!(erudaEnabled && window.eruda)) return;
    if (!window.__ROM_WEAVER_ERUDA_INITIALIZED__) {
      window.__ROM_WEAVER_ERUDA_INITIALIZED__ = true;
      window.eruda.init({ tool: ERUDA_TOOLS });
      console.log("Mobile dev tools initialized");
    }
    scheduleHideFloatingErudaButton();
  };
  const getErudaShadowRoot = () => document.getElementById("eruda")?.shadowRoot ?? null;
  const hideFloatingErudaButton = () => {
    const entryButton = getErudaShadowRoot()?.querySelector(".eruda-entry-btn");
    if (entryButton instanceof HTMLElement) entryButton.style.display = "none";
  };
  const scheduleHideFloatingErudaButton = () => {
    hideFloatingErudaButton();
    window.requestAnimationFrame(hideFloatingErudaButton);
    window.setTimeout(hideFloatingErudaButton, 50);
    window.setTimeout(hideFloatingErudaButton, 250);
  };
  const getErudaPanelElements = () => {
    const shadowRoot = getErudaShadowRoot();
    const container = shadowRoot?.querySelector(".eruda-container");
    const devTools = shadowRoot?.querySelector(".eruda-dev-tools");
    return {
      container: container instanceof HTMLElement ? container : null,
      devTools: devTools instanceof HTMLElement ? devTools : null,
      shadowRoot,
    };
  };
  const isErudaPanelOpen = () => {
    const { container, devTools } = getErudaPanelElements();
    return !!(
      container &&
      !container.classList.contains("__chobitsu-hide__") &&
      (!devTools || devTools.style.display !== "none")
    );
  };
  const syncErudaPanelOpenState = () => setErudaPanelOpen(isErudaPanelOpen());
  const openErudaPanel = () => {
    hideFloatingErudaButton();
    const { container, devTools, shadowRoot } = getErudaPanelElements();
    if (!shadowRoot) return;
    container?.classList.remove("__chobitsu-hide__");
    if (devTools) {
      devTools.style.display = "block";
      devTools.style.opacity = "1";
    }
    const consoleTab = shadowRoot.querySelector('.luna-tab-item[data-id="console"]');
    if (consoleTab instanceof HTMLElement) consoleTab.click();
    setErudaPanelOpen(true);
  };
  const closeErudaPanel = () => {
    if (window.eruda && typeof window.eruda.hide === "function") window.eruda.hide();
    const { container, devTools } = getErudaPanelElements();
    container?.classList.add("__chobitsu-hide__");
    if (devTools) {
      devTools.style.display = "none";
      devTools.style.opacity = "0";
    }
    scheduleHideFloatingErudaButton();
    setErudaPanelOpen(false);
  };
  const forceOpenErudaPanel = () => {
    openErudaPanel();
  };
  const scheduleForceOpenErudaPanel = () => {
    forceOpenErudaPanel();
    window.requestAnimationFrame(forceOpenErudaPanel);
    window.setTimeout(forceOpenErudaPanel, 50);
  };
  const showEruda = () => {
    if (!(erudaEnabled && window.eruda)) return;
    initEruda();
    openErudaWhenReady = false;
    if (typeof window.eruda.show === "function") {
      window.eruda.show();
      window.eruda.show("console");
    }
    scheduleForceOpenErudaPanel();
  };
  const loadEruda = () => {
    erudaEnabled = true;
    window.ROM_WEAVER_ERUDA_ENABLED = true;
    if (window.eruda) {
      initEruda();
      return;
    }
    if (erudaLoadPromise) return;
    erudaScriptLoading = true;

    erudaLoadPromise = import("eruda")
      .then((module) => {
        window.eruda = module.default as Eruda;
        initEruda();
        if (openErudaWhenReady) showEruda();
      })
      .catch((err: unknown) => {
        openErudaWhenReady = false;
        console.error("Failed to load bundled mobile dev tools", err);
      })
      .finally(() => {
        erudaScriptLoading = false;
        erudaLoadPromise = null;
      });
  };
  const openEruda = () => {
    if (!erudaEnabled) return;
    openErudaWhenReady = true;
    loadEruda();
    showEruda();
  };
  const toggleEruda = () => {
    if (!erudaEnabled) {
      openErudaWhenReady = false;
      setErudaPanelOpen(false);
      return;
    }
    if (erudaScriptLoading && openErudaWhenReady) {
      openErudaWhenReady = false;
      setErudaPanelOpen(false);
      return;
    }
    if (erudaEnabled && window.eruda && isErudaPanelOpen()) {
      closeErudaPanel();
      return;
    }
    openEruda();
  };
  const unloadEruda = () => {
    erudaEnabled = false;
    openErudaWhenReady = false;
    window.ROM_WEAVER_ERUDA_ENABLED = false;
    setErudaPanelOpen(false);
    if (!(window.eruda && window.__ROM_WEAVER_ERUDA_INITIALIZED__)) return;
    if (typeof window.eruda.destroy === "function") window.eruda.destroy();
    else if (typeof window.eruda.hide === "function") window.eruda.hide();
    window.__ROM_WEAVER_ERUDA_INITIALIZED__ = false;
  };
  const syncErudaAvailability = () => {
    if (devToolsEnabled && canUseEruda()) loadEruda();
    else unloadEruda();
  };
  const setErudaEnabled = (enabled: RuntimeValue) => {
    devToolsEnabled = !!enabled;
    syncErudaAvailability();
  };

  window.ROM_WEAVER_ERUDA_LOADER = {
    isEnabled: () => erudaEnabled,
    isOpen: () => erudaPanelOpen,
    open: openEruda,
    setEnabled: (enabled) => {
      setErudaEnabled(!!enabled);
    },
    syncFromStoredSettings: () => {
      setErudaEnabled(readStoredErudaSetting());
    },
    toggle: toggleEruda,
  };
  if (typeof mobileErudaMedia?.addEventListener === "function")
    mobileErudaMedia.addEventListener("change", syncErudaAvailability);
  else if (typeof mobileErudaMedia?.addListener === "function") mobileErudaMedia.addListener(syncErudaAvailability);
  syncErudaPanelOpenState();
  devToolsEnabled = readStoredErudaSetting();
  syncErudaAvailability();
})();
