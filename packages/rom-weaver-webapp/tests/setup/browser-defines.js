// Vitest 5.0.0 browser mode copies Vite's `define` map onto `globalThis`
// verbatim instead of parsing it first, so every `__NAME__` global arrives as
// the raw source text ('"0.15.1"', "false", "0") rather than its value. Vitest
// 4 parsed the map (`deleteDefineConfig`) before assigning it. Browser mode is
// also the only mode where Vite's own textual replacement does not win, so
// these globals are what the app actually reads.
//
// This setup file restores the parsed values. It MUST run before any test or
// source module reads a define, which `test.setupFiles` guarantees. Remove it
// once the upstream regression is fixed.
const DEFINE_NAME = /^__[A-Z0-9_]+__$/;

for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (!DEFINE_NAME.test(name)) continue;
  const raw = globalThis[name];
  if (typeof raw !== "string") continue;
  try {
    globalThis[name] = JSON.parse(raw);
  } catch {
    // A define whose value is a code reference, not JSON. Leave it alone.
  }
}
