import { useSyncExternalStore } from "react";
import { createLogger } from "../lib/logging.ts";

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

/**
 * The dye lots, in the settings picker's order. Source of truth for the
 * `--thread` / `--thread-hi` literals in design-system/accents.css (asserted by
 * tests/unit/accent-palette.test.ts) and for the per-channel app icons that
 * scripts/generate-channel-icons.mjs rasterizes.
 *
 * `highlight` is the logo's specular tint: hue and saturation of the swatch at
 * `l + (100 - l) * 0.6`. Madder keeps the hand-picked value it has always
 * shipped (the rule would land 4 points off) so the stock mark is unchanged.
 */
const ACCENTS = [
  { highlight: "#fccb90", label: "Madder", swatch: "#d9690f", value: "madder" },
  { highlight: "#c5cbf6", label: "Woad", swatch: "#6d7ce8", value: "woad" },
  { highlight: "#d7c3f3", label: "Violet", swatch: "#9a6ae0", value: "violet" },
  { highlight: "#aee1c6", label: "Verdigris", swatch: "#3faa72", value: "verdigris" },
  { highlight: "#9fe2e7", label: "Teal", swatch: "#2aa0a8", value: "teal" },
  { highlight: "#eac1db", label: "Plum", swatch: "#cb63a5", value: "plum" },
] as const;

type Accent = (typeof ACCENTS)[number]["value"];

const DEFAULT_ACCENT: Accent = "madder";
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
