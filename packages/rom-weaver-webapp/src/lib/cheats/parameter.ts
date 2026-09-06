/**
 * Placeholder handling for the raw code of a database cheat that needs a value.
 * The runs this finds MUST match the Rust `contains_parameter_placeholder` rule
 * (`crates/rom-weaver-cli/src/cheats/mod.rs`): a `?` run of any width, or an
 * `X`/`x` run of at least two characters. A lone `X` is a hex digit.
 *
 * This covers only the raw code. Rust also marks a record `requiresParameter`
 * for a placeholder in an executable raw field
 * (`has_parameterized_executable_field`); those entries have no editor here and
 * `findPlaceholders` reports nothing for them.
 */

export type CheatPlaceholder = {
  /** Index of the run's first character in the raw code. */
  index: number;
  /** Number of hex digits the run stands for. */
  width: number;
  /** Normalized placeholder character, `?` or `X`. */
  character: "?" | "X";
};

const MIN_LETTER_RUN = 2;

const isPlaceholderChar = (value: string): value is "?" | "X" | "x" => value === "?" || value === "X" || value === "x";

/** Every placeholder run in `rawCode`, in reading order. */
export const findPlaceholders = (rawCode: string | null | undefined): CheatPlaceholder[] => {
  if (!rawCode) return [];
  const runs: CheatPlaceholder[] = [];
  let index = 0;
  while (index < rawCode.length) {
    const character = rawCode[index] as string;
    if (!isPlaceholderChar(character)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < rawCode.length && rawCode[end]?.toUpperCase() === character.toUpperCase()) end += 1;
    const width = end - index;
    if (character === "?" || width >= MIN_LETTER_RUN) {
      runs.push({ index, width, character: character === "?" ? "?" : "X" });
    }
    index = end;
  }
  return runs;
};

/** Largest value a run of `width` hex digits can hold, as uppercase hex. */
export const placeholderMaximum = (width: number): string => "F".repeat(Math.max(1, width));

/** The inline hint beside a value input: what to type and the allowed range. */
export const placeholderHint = (width: number): string =>
  `hex · ${width} digit${width === 1 ? "" : "s"} · 0 to ${placeholderMaximum(width)}`;

/** Decimal reading of a hex value, or `undefined` when it is not valid hex. */
export const placeholderDecimal = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]+$/u.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 16);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * True when `value` is hex and exactly as wide as the run. A half-typed value
 * is not complete: classifying "6" of an intended "63" would briefly resolve
 * the card to a code the user never meant, and cost one WASM call per keystroke.
 */
export const isPlaceholderValueComplete = (placeholder: CheatPlaceholder, value: string | undefined): boolean => {
  const trimmed = (value ?? "").trim();
  return trimmed.length === placeholder.width && /^[0-9a-fA-F]+$/u.test(trimmed);
};

/**
 * Replace every placeholder run with its value, uppercased. Returns `undefined`
 * unless every run holds exactly its width of hex digits, so callers never
 * classify a half-typed code.
 */
export const fillPlaceholders = (
  rawCode: string | null | undefined,
  values: ReadonlyArray<string | undefined>,
): string | undefined => {
  if (!rawCode) return undefined;
  const placeholders = findPlaceholders(rawCode);
  if (!placeholders.length) return undefined;
  let filled = "";
  let cursor = 0;
  for (const [position, placeholder] of placeholders.entries()) {
    const value = values[position];
    if (!isPlaceholderValueComplete(placeholder, value)) return undefined;
    filled += rawCode.slice(cursor, placeholder.index);
    filled += (value as string).trim().toUpperCase().padStart(placeholder.width, "0");
    cursor = placeholder.index + placeholder.width;
  }
  return filled + rawCode.slice(cursor);
};
