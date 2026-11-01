const SHORTHAND = /^(-?\d+(?:\.\d+)?)([kmb])$/i;
const SHORTHAND_FACTOR: Record<string, number> = { b: 1e9, k: 1e3, m: 1e6 };

/** The number in `text`, or null when it is empty or not a finite number. */
export const parseSaveNumber = (text: string): number | null => {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

const separatorsFor = (locale: string): { decimal: string; group: string } => {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1_000_000.5);
    return {
      decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
      group: parts.find((part) => part.type === "group")?.value ?? ",",
    };
  } catch {
    return { decimal: ".", group: "," };
  }
};

/**
 * Typed text as the editor stores it: the locale's grouping character, spaces
 * and underscores drop out, its decimal mark becomes `.`, and `50k` / `1.5m`
 * expand, so large values are quick to enter and the shown number can be typed
 * back. Text that is not a number passes through for the field validation to reject.
 */
export const normalizeSaveNumberText = (raw: string, locale = "en-US"): string => {
  const { decimal, group } = separatorsFor(locale);
  const compact = raw.trim().replace(/[\s_]/g, "").split(group).join("").split(decimal).join(".");
  const match = SHORTHAND.exec(compact);
  if (!match) return compact;
  const factor = SHORTHAND_FACTOR[(match[2] ?? "").toLowerCase()] ?? 1;
  return String(Math.round(Number.parseFloat(match[1] ?? "0") * factor));
};

/** Move `value` onto the field's step grid, anchored at `min`, and keep it inside `min`..`max`. */
export const snapSaveNumber = (value: number, min: number, max: number, step: number): number => {
  const size = step > 0 ? step : 1;
  const snapped = min + Math.round((value - min) / size) * size;
  if (snapped > max) return min + Math.floor((max - min) / size) * size;
  return Math.max(min, snapped);
};

/** Where `value` sits between `min` and `max`, from 0 to 1. */
export const saveNumberFraction = (value: number, min: number, max: number): number =>
  max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;

/**
 * The value a key press on the slider asks for, or null for keys it ignores.
 * Arrows step (Shift for ten steps), Page Up and Page Down step by ten, and
 * Home and End jump to the ends.
 */
export const saveNumberKeyTarget = (
  key: string,
  shift: boolean,
  value: number,
  range: { max: number; min: number; step: number },
): number | null => {
  const small = range.step * (shift ? 10 : 1);
  const large = range.step * 10;
  switch (key) {
    case "ArrowDown":
    case "ArrowLeft":
      return value - small;
    case "ArrowRight":
    case "ArrowUp":
      return value + small;
    case "PageDown":
      return value - large;
    case "PageUp":
      return value + large;
    case "Home":
      return range.min;
    case "End":
      return range.max;
    default:
      return null;
  }
};
