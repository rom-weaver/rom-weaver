import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import type { ThreadBudget } from "@rom-weaver/wasm";

const toThreadBudget = (value: unknown, fallback: ThreadBudget | null = null): ThreadBudget | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = Math.floor(value);
    return parsed >= 1 ? parsed : fallback;
  }
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  // Resolve "auto" to the host's core count here instead of forwarding the literal string. The wasm
  // worker's "auto" fallback is a fixed default (4), so leaving it unresolved would cap the browser
  // well below the available cores; passing an explicit count lets compress/extract use every core,
  // matching the resolved value shown by the settings placeholder.
  if (normalized === "auto") return getDefaultBrowserThreadCount();
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
};

export { toThreadBudget };
