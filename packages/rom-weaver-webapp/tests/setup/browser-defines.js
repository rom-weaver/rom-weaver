// Parse JSON define values exposed as source strings by the browser test runner.
// This setup MUST run before source modules read those globals.
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
