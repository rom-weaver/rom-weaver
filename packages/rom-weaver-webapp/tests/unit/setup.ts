import { cleanup } from "@testing-library/preact";
import { afterEach } from "vitest";

// `globals` is off, so @testing-library/preact never registers its own auto-cleanup and every
// renderHook stays mounted for the whole file. Hooks that schedule timers then fire them into a
// dead root after the environment tears down - happy-dom deletes `window`, and Preact reads
// bare `window.event` on any setState outside an event handler, so the timer throws
// `ReferenceError: window is not defined` as an unhandled error and fails the run.
// Most unit files run in the node environment and render nothing; cleanup is a no-op there.
afterEach(() => {
  if (typeof document === "undefined") return;
  cleanup();
});
