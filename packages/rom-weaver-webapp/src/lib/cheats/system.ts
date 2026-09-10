import type { CheatManualSystem } from "./model.ts";

/** A stable id for a hand-entered code, so re-entering one reuses its record. */
const manualCheatId = (system: CheatManualSystem, code: string, kind: string): string => {
  let hash = 2_166_136_261;
  for (const character of `${system}\0${kind}\0${code}`) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `manual-${system}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

export { manualCheatId };
