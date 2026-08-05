import { useSyncExternalStore } from "react";
import { createLogger } from "../lib/logging.ts";
import { ACCENTS, DEFAULT_ACCENT } from "./accent-palette.mjs";

/**
 * Accent dye lots. The accent is the second theme axis alongside dark/light:
 * it re-dyes the `--thread` tokens (design-system/accents.css) without touching
 * chassis, plate or ink. Madder is the baseline defined in tokens.css.
 *
 * The active accent is reflected on `<html data-accent>`; madder clears the
 * attribute so the untouched tokens.css values apply. The value itself lives in
 * the settings store (`accent` field) - this module only owns the vocabulary
 * and the DOM application.
 */

const logger = createLogger("accent");

type Accent = (typeof ACCENTS)[number]["value"];
const ACCENT_VALUES: readonly string[] = ACCENTS.map((accent) => accent.value);

const isAccent = (value: unknown): value is Accent => typeof value === "string" && ACCENT_VALUES.includes(value);

const listeners = new Set<() => void>();
let current: Accent = DEFAULT_ACCENT;

const getAccent = (): Accent => current;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * The class that arms the `--thread*` crossfade in accents.css. It rides only
 * a real accent change - never the boot apply, which must keep matching the
 * pre-paint resolve in index.html without a dissolve - and comes off again
 * once the transition has finished so theme flips stay instant.
 */
const ANIMATION_CLASS = "accent-anim";
/** Outlives the .45s CSS transition so it can't be cut short mid-fade. */
const ANIMATION_DURATION_MS = 600;

let animationTimer: ReturnType<typeof setTimeout> | undefined;
let hasAppliedBefore = false;

const armAccentAnimation = (root: HTMLElement) => {
  root.classList.add(ANIMATION_CLASS);
  if (animationTimer !== undefined) clearTimeout(animationTimer);
  animationTimer = setTimeout(() => {
    animationTimer = undefined;
    root.classList.remove(ANIMATION_CLASS);
    logger.trace("Accent animation finished", { accent: current });
  }, ANIMATION_DURATION_MS);
};

/**
 * Reflect the accent on the document root. Unknown values fall back to the
 * baseline rather than leaving a stale dye on the element.
 *
 * The CSS tokens key off `<html data-accent>`, but the logo mark is an <img>
 * that CSS can't reach into, so components need the value too - hence the
 * store. Mirrors theme.ts, the other axis of the same appearance system.
 */
const applyAccent = (value: unknown) => {
  const accent = isAccent(value) ? value : DEFAULT_ACCENT;
  const changed = accent !== current;
  const animate = changed && hasAppliedBefore;
  hasAppliedBefore = true;
  current = accent;
  if (typeof document !== "undefined" && document.documentElement) {
    // Class before attribute: transition-property is read from the after-change
    // style, so both landing in one style recalc still starts the crossfade.
    if (animate) armAccentAnimation(document.documentElement);
    if (accent === DEFAULT_ACCENT) document.documentElement.removeAttribute("data-accent");
    else document.documentElement.setAttribute("data-accent", accent);
  }
  logger.trace("Applied accent", { accent, animate, changed, requested: value });
  if (changed) for (const listener of listeners) listener();
};

/** Subscribe a component to the active accent. */
const useAccent = (): Accent => useSyncExternalStore(subscribe, getAccent, getAccent);

export { ACCENTS, applyAccent, DEFAULT_ACCENT, useAccent };
export type { Accent };
