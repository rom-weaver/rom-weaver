import { Cloud, HardDrive, Heart, House, Newspaper, ScrollText, Search, Settings } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocsNavigationRoute } from "../workflow-routes.tsx";
import { BrandMark } from "./brand-mark.tsx";
import { FIND_SHORTCUT_HINT, FindPalette } from "./find-palette.tsx";
import type { FindAction } from "../find-index.ts";
import type { RomLookupSelection } from "../../public/react/use-rom-lookup.ts";
import { useRomWeaverSettings, useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";
import { Github } from "./shell-common.tsx";
import type { NavGroup, NavSectionData, WorkflowTab } from "./shell-nav.tsx";
import { MenuSheet, NAV_GROUP_TITLES, PhoneDock, SideNav, fullNameFor, visibleFirst } from "./shell-nav.tsx";
import { AccentTile, MENU_TOOL_SCOPE, ProjectTiles, SettingsTile, ThemeTile } from "./menu-tools.tsx";
import type { OfflineWarmupDisplayProgress, RuntimeState } from "./runtime-status.tsx";
import {
  BuildTag,
  HEADER_RUNTIME_MESSAGES,
  RUNTIME_MESSAGES,
  RuntimeGlyph,
  StatusChip,
  describeWarmupUnit,
  guardExternalClick,
  installingRuntimeLabel,
  installingRuntimeWording,
  offlineWarmupPercent,
  resolveRuntimeState,
  useHydratedServiceWorkerStatus,
} from "./runtime-status.tsx";

const Masthead = ({
  channelBadge,
  commitsSinceVersion,
  onAccentChange,
  tabs,
  currentTab,
  docsSlug = "docs",
  dirty,
  homeHref,
  onSelectTab,
  onOpenWhatsNew,
  onOpenLog,
  onOpenStatus,
  onOpenStorage,
  onPreloadLog,
  onOpenSettings,
  onOpenSettingsField,
  onIdentifyQuery,
  serviceWorkerStatus,
  offlineProgress = null,
  previewRuntimeState = null,
  previewPhoneOverlay = false,
  previewVersionStatus = false,
  confirmExternalNavigation,
  donateHref,
  githubHref,
  updateReady = false,
  version,
  versionTitle,
}: {
  /** Deploy channel marker; empty on production, which wears the plain brand. */
  channelBadge?: string;
  commitsSinceVersion?: number | null;
  onAccentChange?: (accent: string) => void;
  tabs: WorkflowTab[];
  currentTab: string;
  docsSlug?: string;
  dirty?: boolean;
  /** Base URL of the app's Home route. */
  homeHref: string;
  onSelectTab: (id: string) => void;
  onOpenWhatsNew: () => void;
  onOpenLog: () => void;
  onOpenStatus: () => void;
  onOpenStorage?: () => void;
  onPreloadLog?: () => void;
  onOpenSettings: () => void;
  /** Find's deep link into one settings field; falls back to plain Settings. */
  onOpenSettingsField?: (fieldId: string) => void;
  /** Send a Find title or checksum result to the Identify workflow. */
  onIdentifyQuery?: (selection: RomLookupSelection) => void;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  previewRuntimeState?: RuntimeState | null;
  previewPhoneOverlay?: boolean;
  previewVersionStatus?: boolean;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  donateHref?: string;
  githubHref?: string;
  updateReady?: boolean;
  version?: string;
  versionTitle?: string;
}) => {
  const settings = useRomWeaverSettings();
  const localizer = useUiLocalizer();
  const betaToolsEnabled = settings.betaToolsEnabled !== false;
  /* Keyed by kind AND copy: the same viewport now shows the pair twice - the
     chrome copy and the one inside the navigation - and a key of "theme" alone
     would open both menus from one press. */
  const [openTool, setOpenTool] = useState<string | null>(null);
  /* The control that opened the popover, so Escape returns focus to it. Several
     copies of the pair are in the DOM at once, so the DOM cannot say which one
     the user actually used. */
  const openToolRef = useRef<HTMLButtonElement | null>(null);
  const toggleTool = (key: string, button: HTMLButtonElement | null) => {
    openToolRef.current = button;
    setOpenTool((open) => (open === key ? null : key));
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [docsExpanded, setDocsExpanded] = useState(currentTab === "docs");
  useEffect(() => {
    if (currentTab === "docs" && docsSlug) setDocsExpanded(true);
  }, [currentTab, docsSlug]);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const findTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dockFindRef = useRef<HTMLButtonElement | null>(null);
  /* Find opens from the top bar on desktop and from the dock on the phone.
     Escape restores focus to whichever of those the layout shows,
     resolved at call time rather than stored, because the layout is CSS's
     decision and this component never reads a breakpoint. */
  const activeFindRef = useMemo(
    () => ({
      get current() {
        return visibleFirst([findTriggerRef.current, dockFindRef.current]);
      },
      set current(node: HTMLButtonElement | null) {
        findTriggerRef.current = node;
      },
    }),
    [],
  );
  const navLabel = localizer.message("ui.nav.primary");

  /* The beta-tools setting is client-only, so the prerendered shell must not
     disagree with the first hydration pass: every beta row is in the markup
     from the start and is revealed once the client setting is known. */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const betaVisible = hydrated && betaToolsEnabled;
  // Find honours the beta-tools setting the way the nav does. It never renders
  // before hydration, so it can read the setting directly.
  const findSources = useMemo(
    () => ({
      baseHref: homeHref,
      donateHref,
      githubHref,
      tabs: tabs.filter((tab) => betaToolsEnabled || !tab.beta),
    }),
    [betaToolsEnabled, donateHref, githubHref, homeHref, tabs],
  );
  const closeFind = useCallback(() => setFindOpen(false), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const onFindAction = (action: FindAction) => {
    if (action.type === "view") onSelectTab(action.view);
    else if (action.type === "identify") onIdentifyQuery?.(action.selection);
    else if (action.type === "settings") {
      if (action.fieldId && onOpenSettingsField) onOpenSettingsField(action.fieldId);
      else onOpenSettings();
    } else if (action.type === "status") onOpenStatus();
    else if (action.type === "storage") (onOpenStorage ?? onOpenLog)();
    else if (action.type === "logs") onOpenLog();
    else if (action.type === "changelog") onSelectTab("whats-new");
    else if (action.type === "external") openExternalFromFind(action.href, confirmExternalNavigation);
  };
  // `/` from anywhere outside a text field, plus the ⌘K / Ctrl+K alias.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const modified = event.metaKey || event.ctrlKey;
      const chord = modified && !event.shiftKey && event.key.toLowerCase() === "k";
      const slash = !modified && event.key === "/" && !isTextEntryTarget(event.target);
      if (!(chord || slash)) return;
      // A modal dialog makes the shell inert; the shortcut must not open a
      // palette nobody can reach behind its backdrop.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setMenuOpen(false);
      setFindOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /* The sheet covers the page and its scrim blocks pointer input, so the
     keyboard has to agree: what the sheet covers goes inert while it is open,
     or Tab walks into controls nobody can see or click. The dock stays live
     because its Menu button is what closes the sheet again, and the scrim is a
     close control in its own right. Only attributes set here are cleared, so a
     dialog that inerted the same node keeps its own. */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const sheet = document.getElementById("menu-sheet");
    const covered = Array.from(sheet?.parentElement?.children ?? []).filter(
      (node) => node !== sheet && !node.matches(".dock, .scrim") && !node.hasAttribute("inert"),
    );
    for (const node of covered) node.setAttribute("inert", "");
    return () => {
      for (const node of covered) node.removeAttribute("inert");
    };
  }, [menuOpen]);

  // Pointer-down rather than click so a press that starts outside dismisses
  // before the target's own handler runs.
  useEffect(() => {
    if (!openTool) return undefined;
    /* Scoped to the anchor, not to one cluster: the appearance tiles render in
       several places and a press inside the copy the current layout shows would
       otherwise count as "outside", closing the popover on pointerdown so the
       click never reached the choice. */
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".tool-anchor")) return;
      setOpenTool(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenTool(null);
      openToolRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openTool]);

  const hydratedStatus = useHydratedServiceWorkerStatus(serviceWorkerStatus);
  const runtimeState =
    previewRuntimeState ??
    resolveRuntimeState(hydratedStatus, updateReady, offlineProgress, settings.offlineCopyEnabled);
  /* The chip prints the percent in its own tabular-numeral span, so the visible
     wording stays percent-free; only the accessible name, which replaces the
     whole chip rather than adding to it, carries the number. */
  const runtimeLabel =
    runtimeState === "installing"
      ? installingRuntimeWording(localizer, offlineProgress)
      : localizer.message(RUNTIME_MESSAGES[runtimeState].label);
  const headerRuntimeLabel = localizer.message(HEADER_RUNTIME_MESSAGES[runtimeState]);
  const runtimeSpokenLabel =
    runtimeState === "installing" ? installingRuntimeLabel(localizer, offlineProgress) : runtimeLabel;
  const runtimePercent = runtimeState === "installing" ? offlineWarmupPercent(offlineProgress) : null;
  const runtimeDetail = runtimeState === "installing" ? describeWarmupUnit(localizer, offlineProgress) : null;
  /* A middle dot, not a second colon: the installing wording already ends in
     ": <percent>%", and "copy: 25%: EmulatorJS file x" reads as one broken list. */
  const runtimeTitle = runtimeDetail ? `${runtimeSpokenLabel} · ${runtimeDetail}` : runtimeSpokenLabel;

  const githubBaseHref = githubHref ? `${githubHref.replace(/\/$/, "")}/` : undefined;
  const commitDistance =
    typeof commitsSinceVersion === "number" && Number.isInteger(commitsSinceVersion) && commitsSinceVersion > 0
      ? commitsSinceVersion
      : 0;
  const openStorage = onOpenStorage ?? onOpenLog;

  /* One description of the nav, rendered by the sidebar and by the phone menu.
     Both layouts MUST carry every destination under the same headings.
     Project comes first on desktop and last in the phone menu. */
  const sections: NavSectionData[] = useMemo(() => {
    const workflowGroup = (group: NavGroup): NavSectionData => ({
      entries: tabs
        .filter((tab) => tab.group === group)
        .map((tab) => ({
          beta: tab.beta,
          current: tab.id === currentTab,
          // The page you are on is always in the nav, even a beta one reached
          // by URL while the setting is off.
          hidden: tab.beta && !betaVisible && tab.id !== currentTab,
          href: tab.href,
          icon: tab.icon,
          id: tab.id,
          label: tab.railLabel ?? tab.label,
          onSelect: () => onSelectTab(tab.id),
          title: fullNameFor(tab),
        })),
      id: group,
      title: localizer.message(NAV_GROUP_TITLES[group]),
    });
    const device: NavSectionData = {
      entries: [
        {
          /* The first client render MUST match the prerendered glyph. The
             parser-time resolver only updates the identity status chips. */
          icon: hydrated && runtimeState === "update" ? <RuntimeGlyph state="update" /> : <Cloud aria-hidden="true" />,
          id: "status",
          label: localizer.message("ui.log.tabStatus"),
          onSelect: onOpenStatus,
        },
        {
          icon: <HardDrive aria-hidden="true" />,
          id: "storage",
          label: localizer.message("ui.log.tabStorage"),
          onSelect: openStorage,
        },
        {
          icon: <ScrollText aria-hidden="true" />,
          id: "logs",
          label: localizer.message("ui.log.tabLogs"),
          onSelect: onOpenLog,
        },
        {
          icon: <Settings aria-hidden="true" />,
          id: "settings",
          label: localizer.message("ui.settings.title"),
          onSelect: onOpenSettings,
        },
      ],
      id: "device",
      title: localizer.message("ui.nav.groupDevice"),
    };
    const project = workflowGroup("project");
    project.entries.unshift({
      current: currentTab === "home",
      href: homeHref,
      icon: <House aria-hidden="true" />,
      id: "home",
      label: localizer.message("ui.nav.homeShort"),
      onSelect: () => onSelectTab("home"),
    });
    project.entries.push({
      current: currentTab === "whats-new",
      href: "whats-new",
      icon: <Newspaper aria-hidden="true" />,
      id: "whats-new",
      label: localizer.message("ui.update.whatsNew"),
      onSelect: () => onSelectTab("whats-new"),
    });
    if (githubHref) {
      project.entries.push({
        external: true,
        href: githubHref,
        icon: <Github aria-hidden="true" />,
        id: "github",
        label: localizer.message("ui.tools.githubShort"),
        onExternalClick: (event) => guardExternalClick(event, githubHref, confirmExternalNavigation),
        title: localizer.message("ui.tools.github"),
      });
    }
    if (donateHref) {
      project.entries.push({
        className: "nav-support",
        external: true,
        href: donateHref,
        icon: <Heart aria-hidden="true" />,
        id: "support",
        label: localizer.message("ui.footer.donate"),
        onExternalClick: (event) => guardExternalClick(event, donateHref, confirmExternalNavigation),
      });
    }
    return [project, workflowGroup("patches"), workflowGroup("roms"), device];
  }, [
    betaVisible,
    confirmExternalNavigation,
    currentTab,
    donateHref,
    githubHref,
    homeHref,
    hydrated,
    localizer,
    onOpenLog,
    onOpenSettings,
    onOpenStatus,
    onSelectTab,
    openStorage,
    runtimeState,
    tabs,
  ]);

  const withDocsNavigation = (navSections: NavSectionData[], onNavigate?: () => void): NavSectionData[] =>
    navSections.map((section) => ({
      ...section,
      entries: section.entries.map((entry) => ({
        ...entry,
        expanded: docsExpanded,
        onToggle: setDocsExpanded,
        children:
          entry.id === "docs" ? (
            <Suspense fallback={null}>
              {docsExpanded ? (
                <DocsNavigationRoute currentSlug={currentTab === "docs" ? docsSlug : ""} onNavigate={onNavigate} />
              ) : null}
            </Suspense>
          ) : undefined,
      })),
    }));
  // No beta workflow claims a dock slot, so the dock needs no reveal pass.
  const dockTabs = tabs.filter((tab) => tab.dock && !tab.beta);
  // Docs and the landing page bring their own h1, so the brand steps down to a
  // span there rather than giving the document two.
  const BrandHeading = currentTab === "docs" || currentTab === "home" || currentTab === "whats-new" ? "span" : "h1";
  const buildTag = version ? (
    <BuildTag
      channelBadge={channelBadge}
      commitDistance={commitDistance}
      confirmExternalNavigation={confirmExternalNavigation}
      dirty={dirty}
      githubBaseHref={githubBaseHref}
      localizer={localizer}
      onOpenWhatsNew={onOpenWhatsNew}
      version={version}
      versionTitle={versionTitle}
    />
  ) : null;
  const headerStatus = (
    <StatusChip
      iconOnly
      label={runtimeLabel}
      onOpenStatus={() => {
        closeMenu();
        onOpenStatus();
      }}
      percent={runtimePercent}
      state={runtimeState}
      title={runtimeTitle}
    />
  );
  const buildFacts = (
    <span className="build-facts">
      {buildTag}
      {previewVersionStatus ? (
        <span className="build-runtime">
          <StatusChip
            label={headerRuntimeLabel}
            onOpenStatus={() => {
              closeMenu();
              onOpenStatus();
            }}
            percent={runtimePercent}
            state={runtimeState}
            title={runtimeTitle}
          />
        </span>
      ) : null}
    </span>
  );
  /* Theme, accent, and settings appear in the chrome (the top bar on desktop,
     the brand row on the phone) and again inside navigation, so each copy owns
     its own popover key and radio group name. */
  const appearanceTiles = (scope: string, navRow = false) => (
    <>
      <ThemeTile
        localizer={localizer}
        navRow={navRow}
        onToggle={(button) => toggleTool(`theme:${scope}`, button)}
        open={openTool === `theme:${scope}`}
      />
      <AccentTile
        localizer={localizer}
        name={`shell-accent-${scope}`}
        navRow={navRow}
        onChange={(accent) => onAccentChange?.(accent)}
        onToggle={(button) => toggleTool(`accent:${scope}`, button)}
        open={openTool === `accent:${scope}`}
      />
    </>
  );
  const settingsTile = (
    <SettingsTile
      localizer={localizer}
      onOpenSettings={() => {
        closeMenu();
        onOpenSettings();
      }}
    />
  );
  const projectTiles = (
    <ProjectTiles
      confirmExternalNavigation={confirmExternalNavigation}
      donateHref={donateHref}
      githubHref={githubHref}
      localizer={localizer}
    />
  );

  return (
    <>
      <a className="skip-link" href="#main-content">
        {localizer.message("ui.common.skipToMain")}
      </a>
      {/* One banner for the whole chrome. It is `display: contents` on desktop,
          so the identity block and the top bar each land in their own grid cell
          while staying inside a single landmark - two `header` elements at this
          level would leave the page with two banners. */}
      <header className="shell-banner">
        {/* One column on desktop, one page header on the phone. */}
        <div className="side-col">
          <div className="shell-head">
            <div className="shell-head-top">
              <span className="brand">
                <a aria-label={localizer.message("ui.nav.home")} className="brand-mark-link" href={homeHref}>
                  <BrandMark />
                </a>
                <span className="brand-copy">
                  <a className="brand-word-link" href={homeHref}>
                    <BrandHeading className="brand-word">
                      rom<span className="brand-hy">-</span>
                      <b>weaver</b>
                    </BrandHeading>
                  </a>
                  {previewVersionStatus ? null : buildFacts}
                </span>
                {previewVersionStatus ? <span className="title-build-row">{buildFacts}</span> : null}
              </span>
              <div className="shell-head-tools">
                <span className="phone-project-tools">{projectTiles}</span>
                <span aria-hidden="true" className="tool-separator" />
                <span className="phone-runtime header-runtime">{headerStatus}</span>
                {appearanceTiles("phone")}
                {settingsTile}
              </div>
            </div>
          </div>
          {/* Desktop: every destination the app has, named, in one column. */}
          <aside className="side-rail">
            <SideNav
              appearance={appearanceTiles("rail", true)}
              localizer={localizer}
              navLabel={navLabel}
              sections={withDocsNavigation(sections)}
            />
          </aside>
        </div>
        {/* Desktop top bar: the one box that reaches everything, and the controls
          that change this browser rather than the app. No destinations, so
          nothing in the app is listed in two navigations. */}
        <div className="topbar">
          <button
            aria-controls="find-palette"
            aria-expanded={findOpen}
            aria-haspopup="dialog"
            aria-keyshortcuts="/ Control+K Meta+K"
            className="topbar-find"
            onClick={() => setFindOpen((open) => !open)}
            ref={findTriggerRef}
            type="button"
          >
            <Search aria-hidden="true" />
            <span className="topbar-find-text">{localizer.message("ui.find.placeholder")}</span>
            <kbd>{FIND_SHORTCUT_HINT}</kbd>
          </button>
          <div className="topbar-tools">
            {projectTiles}
            <span aria-hidden="true" className="tool-separator" />
            <span className="desktop-runtime header-runtime">{headerStatus}</span>
            {appearanceTiles("desktop")}
            {settingsTile}
          </div>
        </div>
      </header>
      <FindPalette
        localizer={localizer}
        onAction={onFindAction}
        onClose={closeFind}
        open={findOpen}
        sources={findSources}
        triggerRef={activeFindRef}
      />
      {previewPhoneOverlay ? (
        <span className="phone-overlay-runtime" data-sw={runtimeState} hidden={menuOpen || findOpen}>
          <StatusChip
            label={runtimeLabel}
            onOpenStatus={() => {
              closeMenu();
              onOpenStatus();
            }}
            percent={runtimePercent}
            state={runtimeState}
            title={runtimeTitle}
          />
        </span>
      ) : null}
      <PhoneDock
        current={currentTab}
        findLabel={localizer.message("ui.find.label")}
        findOpen={findOpen}
        findTriggerRef={dockFindRef}
        menuLabel={localizer.message("ui.tools.menu")}
        menuOpen={menuOpen}
        navLabel={navLabel}
        onSelect={onSelectTab}
        onToggleFind={() => {
          setMenuOpen(false);
          setFindOpen((open) => !open);
        }}
        onToggleMenu={() => {
          setFindOpen(false);
          onPreloadLog?.();
          setMenuMounted(true);
          setMenuOpen((open) => !open);
        }}
        tabs={dockTabs}
        triggerRef={menuTriggerRef}
      />
      {/* The parser-time resolver runs here, after the identity slots exist. */}
      <span className="shell-identity" hidden />
      <MenuSheet
        appearance={appearanceTiles(MENU_TOOL_SCOPE, true)}
        localizer={localizer}
        onClose={closeMenu}
        open={menuOpen}
        opened={menuMounted}
        sections={withDocsNavigation(
          [
            ...sections.filter((section) => section.id !== "project"),
            ...sections.filter((section) => section.id === "project"),
          ],
          closeMenu,
        )}
        toolOpen={openTool === `theme:${MENU_TOOL_SCOPE}` || openTool === `accent:${MENU_TOOL_SCOPE}`}
        triggerRef={menuTriggerRef}
      />
      {/* A real button, so the backdrop is dismissable by keyboard too and
          carries a name rather than being an unlabelled click surface. */}
      <button
        aria-label={localizer.message("ui.common.close")}
        className="scrim"
        hidden={!menuOpen}
        onClick={closeMenu}
        type="button"
      />
    </>
  );
};

/** `/` MUST keep typing into a field; only a bare `/` on the page opens Find. */
const isTextEntryTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
};

/** Find's external rows open like the nav links: guarded when a job is running. */
const openExternalFromFind = (href: string, confirmExternalNavigation?: (href: string) => Promise<boolean>) => {
  if (!confirmExternalNavigation) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  void confirmExternalNavigation(href).then((accepted) => {
    if (accepted) window.open(href, "_blank", "noopener,noreferrer");
  });
};

export { Masthead };
