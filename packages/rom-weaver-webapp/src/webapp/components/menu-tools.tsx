import { Heart, MonitorCog, Moon, Palette, Settings, SunMedium } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { ACCENTS, useAccent } from "../accent.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { runAppearanceTransition } from "../appearance-transition.ts";
import type { ThemePreference } from "../theme.ts";
import { useTheme } from "../theme.ts";
import { Github } from "./shell-common.tsx";
import { guardExternalClick } from "./runtime-status.tsx";

/** The Menu sheet's copy of the appearance pair, as its popover keys spell it. */
const MENU_TOOL_SCOPE = "menu";

const THEME_CHOICES: ReadonlyArray<{ icon: ReactNode; label: MessageId; value: ThemePreference }> = [
  { icon: <SunMedium aria-hidden="true" />, label: "ui.theme.light", value: "light" },
  { icon: <Moon aria-hidden="true" />, label: "ui.theme.dark", value: "dark" },
  { icon: <MonitorCog aria-hidden="true" />, label: "ui.theme.matchSystem", value: "auto" },
];

/** Nav panels MUST enter the top layer so the scroll boxes cannot clip them. */
const useNavToolPopover = (
  open: boolean,
  navRow: boolean,
  buttonRef: RefObject<HTMLButtonElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
) => {
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!(open && navRow && button && panel)) return undefined;

    if (typeof panel.showPopover === "function") panel.showPopover();
    else panel.removeAttribute("popover");

    const position = () => {
      const trigger = button.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const margin = 8;
      const gap = 4;
      const left = Math.max(margin, Math.min(trigger.left, window.innerWidth - width - margin));
      const below = trigger.bottom + gap;
      const above = trigger.top - height - gap;
      let top = below;
      if (below + height > window.innerHeight - margin) {
        top = above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - height - margin));
      }
      const maxTop = Math.max(margin, window.innerHeight - height - margin);
      top = Math.max(margin, Math.min(top, maxTop));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (typeof panel.hidePopover === "function" && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [open, navRow, buttonRef, panelRef]);
};

/**
 * Theme as a menu, not a cycle: three named choices, each showing which one is
 * on. A toggle could not say what "follow the system" was doing, and a second
 * click on a cycle was the control users read as broken.
 */
const ThemeTile = ({
  localizer,
  navRow = false,
  onToggle,
  open,
}: {
  localizer: Localizer;
  navRow?: boolean;
  onToggle: (button: HTMLButtonElement | null) => void;
  open: boolean;
}) => {
  const { preference, setPreference, theme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Touch browsers can synthesize a click with detail=0, so capture the
  // pointer before the click and keep keyboard activation centered.
  const themePointerRef = useRef<{ x: number; y: number } | null>(null);
  useNavToolPopover(open, navRow, buttonRef, panelRef);
  const label = localizer.message("ui.tools.theme");
  const current = THEME_CHOICES.find((choice) => choice.value === preference);
  const currentName = localizer.message(current?.label ?? "ui.theme.matchSystem");
  return (
    <span className={navRow ? "tool-anchor nav-tool-anchor" : "tool-anchor"}>
      <button
        aria-expanded={open}
        aria-label={`${label}: ${currentName}`}
        className={navRow ? "tool nav-row nav-tool" : "tool"}
        onClick={() => onToggle(buttonRef.current)}
        ref={buttonRef}
        type="button"
      >
        <Moon aria-hidden="true" className="ico-moon" />
        <SunMedium aria-hidden="true" className="ico-sun" />
        {navRow ? (
          <span className="nav-row-label">{label}</span>
        ) : (
          <span aria-hidden="true" className="tip">
            {label}
          </span>
        )}
      </button>
      {open ? (
        <div
          className={navRow ? "tool-pop nav-tool-pop" : "tool-pop"}
          popover={navRow ? "manual" : undefined}
          ref={panelRef}
          role="menu"
        >
          <p className="tool-pop-head">{label}</p>
          {THEME_CHOICES.map((choice) => (
            <button
              aria-checked={choice.value === preference}
              className="tool-pop-item"
              key={choice.value}
              onPointerCancel={() => {
                themePointerRef.current = null;
              }}
              onPointerDown={(event) => {
                themePointerRef.current = { x: event.clientX, y: event.clientY };
              }}
              onClick={(event) => {
                const pointer = themePointerRef.current;
                themePointerRef.current = null;
                runAppearanceTransition(
                  () => {
                    setPreference(choice.value);
                    onToggle(buttonRef.current);
                  },
                  "theme",
                  event.currentTarget,
                  pointer ?? (event.detail > 0 ? { x: event.clientX, y: event.clientY } : undefined),
                );
              }}
              onKeyDown={() => {
                themePointerRef.current = null;
              }}
              role="menuitemradio"
              type="button"
            >
              {choice.icon}
              {localizer.message(choice.label)}
              {choice.value === "auto" ? (
                <span className="tool-pop-note">
                  {localizer.message(theme === "dark" ? "ui.theme.dark" : "ui.theme.light")}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
};

/**
 * Accent quick picker: the button wears the live dye, and opening it drops the
 * six lots below it. Choosing one commits immediately - the picker exists
 * precisely to skip the settings panel's draft/Save round trip, and an accent
 * is self-evidently reversible. It stays open on pick so comparing two lots
 * does not cost a reopen.
 */
const AccentTile = ({
  localizer,
  name,
  navRow = false,
  onChange,
  onToggle,
  open,
}: {
  localizer: Localizer;
  /** Radio group name. Two pickers share the page, and one name would join them. */
  name: string;
  navRow?: boolean;
  onChange: (accent: string) => void;
  onToggle: (button: HTMLButtonElement | null) => void;
  open: boolean;
}) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  useNavToolPopover(open, navRow, buttonRef, panelRef);
  const accent = useAccent();
  const label = localizer.message("ui.tools.accent");
  const currentLabel = ACCENTS.find((entry) => entry.value === accent)?.label ?? "";

  // Opening with the keyboard has to land somewhere; the current lot is the
  // only sensible anchor for the arrow keys that follow.
  useEffect(() => {
    if (!open) return;
    trayRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [open]);

  return (
    <span className={navRow ? "tool-anchor nav-tool-anchor" : "tool-anchor"}>
      <button
        aria-expanded={open}
        aria-label={`${label}: ${currentLabel}`}
        className={navRow ? "tool accent-tool nav-row nav-tool" : "tool accent-tool"}
        onClick={() => onToggle(buttonRef.current)}
        ref={buttonRef}
        type="button"
      >
        <Palette aria-hidden="true" />
        <span aria-hidden="true" className="accent-tool-dot" />
        {navRow ? (
          <span className="nav-row-label">{label}</span>
        ) : (
          <span aria-hidden="true" className="tip">
            {label}
          </span>
        )}
      </button>
      {open ? (
        <div
          className={navRow ? "tool-pop accent-pop nav-tool-pop" : "tool-pop accent-pop"}
          popover={navRow ? "manual" : undefined}
          ref={panelRef}
        >
          <p className="tool-pop-head">{`${label}: ${currentLabel}`}</p>
          <div aria-label={label} className="accent-tray" ref={trayRef} role="radiogroup">
            {ACCENTS.map((entry) => (
              <label className="accent-chip" key={entry.value} title={entry.label}>
                <input
                  aria-label={entry.label}
                  checked={entry.value === accent}
                  name={name}
                  onChange={() => {
                    runAppearanceTransition(() => onChange(entry.value), "accent");
                  }}
                  type="radio"
                  value={entry.value}
                />
                <span aria-hidden="true" className="accent-chip-dot" style={{ background: entry.swatch }} />
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
};

/** Source and support: the project links shared by the desktop and phone chrome. */
const ProjectTiles = ({
  confirmExternalNavigation,
  donateHref,
  githubHref,
  localizer,
}: {
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  donateHref?: string;
  githubHref?: string;
  localizer: Localizer;
}) => {
  const githubLabel = localizer.message("ui.tools.github");
  const supportLabel = localizer.message("ui.footer.donate");
  return (
    <>
      {githubHref ? (
        <a
          aria-label={githubLabel}
          className="tool tool-project"
          href={githubHref}
          onClick={(event) => guardExternalClick(event, githubHref, confirmExternalNavigation)}
          rel="noreferrer"
          target="_blank"
        >
          <Github aria-hidden="true" />
          <span aria-hidden="true" className="tip">
            {localizer.message("ui.tools.githubShort")}
          </span>
        </a>
      ) : null}
      {donateHref ? (
        <a
          aria-label={supportLabel}
          className="tool tool-project tool-support"
          href={donateHref}
          onClick={(event) => guardExternalClick(event, donateHref, confirmExternalNavigation)}
          rel="noreferrer"
          target="_blank"
        >
          <Heart aria-hidden="true" />
          <span aria-hidden="true" className="tip">
            {supportLabel}
          </span>
        </a>
      ) : null}
    </>
  );
};

const SettingsTile = ({ localizer, onOpenSettings }: { localizer: Localizer; onOpenSettings: () => void }) => {
  const label = localizer.message("ui.settings.title");
  return (
    <button aria-label={label} className="tool" onClick={onOpenSettings} type="button">
      <Settings aria-hidden="true" />
      <span aria-hidden="true" className="tip">
        {label}
      </span>
    </button>
  );
};

export { AccentTile, MENU_TOOL_SCOPE, ProjectTiles, SettingsTile, ThemeTile };
