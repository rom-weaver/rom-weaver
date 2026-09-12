import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are disabled, so this setup MUST register React Testing Library cleanup explicitly.
// Unmount hooks before environment teardown to release their timers and subscriptions.
afterEach(() => {
  if (typeof document === "undefined") return;
  cleanup();
});
