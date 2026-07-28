/**
 * On-device probe for the assumption behind the Apple-only shared-memory cap.
 *
 * `createSharedThreadMemory` asks for the module's link-time 4 GiB maximum and steps down a ladder
 * when the engine refuses, because WebKit reserves a shared memory's whole `maximum` address range
 * up front. `resolveAppleMobileSharedMemoryMaximumPages` pre-caps that request, but only for Apple
 * mobile - every other runtime, Android included, asks for the full 4 GiB.
 *
 * That split is a claim about engine behaviour, and it has never been measured on a real Android
 * device. This probe measures it: what maximum does *this* engine actually grant, and how many such
 * reservations can coexist? Load `mobile-safari-matrix.html?profile=memory` on a phone and read the
 * answer off the page.
 *
 * Reservation only - it never grows a memory or writes a byte, so it measures address-space
 * reservation (the Apple-specific behaviour in question) without committing physical pages.
 */

import { hasMobileToken, isAppleMobileWebKit } from "../platform/shared/webkit-runtime.ts";
import {
  resolveAppleMobileSharedMemoryMaximumPages,
  resolveMemoryCeilingBytes,
} from "../lib/runtime/op-memory-estimate.ts";
import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";

const WASM_PAGE_BYTES = 64 * 1024;
const PAGES_PER_GIB = (1024 * 1024 * 1024) / WASM_PAGE_BYTES;

// The module's link-time --max-memory (.cargo/config.toml): 65536 pages * 64 KiB = 4 GiB.
const FULL_MAXIMUM_PAGES = 65536;
// Mirrors createSharedThreadMemory's ladder so the probe reports the rung the runtime would land on.
const LADDER_PAGES = [FULL_MAXIMUM_PAGES, 49152, 32768, 24576, 16384, 8192, 4096];
const INITIAL_PAGES = 256;
// The mobile ceiling one runner reserves; coexistence at this size is what the warm-idle-runner
// policy is really about.
const COEXIST_PAGES = 16384;
const COEXIST_LIMIT = 8;

type SharedMemoryProbeReport = {
  coexistingAtMobileCeiling: number;
  grantedMaximumPages: number | null;
  laddered: boolean;
  policyCapPages: number | undefined;
  runtime: {
    appleMobileWebKit: boolean;
    deviceMemoryGib: number | null;
    hardwareConcurrency: number | null;
    memoryCeilingBytes: number;
    mobileToken: boolean;
    userAgent: string;
  };
};

const pagesToGib = (pages: number) => (pages / PAGES_PER_GIB).toFixed(2);

const tryReserve = (maximum: number): WebAssembly.Memory | null => {
  try {
    return new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum, shared: true });
  } catch {
    return null;
  }
};

const describeRuntime = (): SharedMemoryProbeReport["runtime"] => {
  const environment = {
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
  const deviceMemory = Number((navigator as { deviceMemory?: number }).deviceMemory);
  return {
    appleMobileWebKit: isAppleMobileWebKit(environment),
    deviceMemoryGib: Number.isFinite(deviceMemory) && deviceMemory > 0 ? deviceMemory : null,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    memoryCeilingBytes: resolveMemoryCeilingBytes(),
    mobileToken: hasMobileToken(environment),
    userAgent: navigator.userAgent,
  };
};

/**
 * Walk the ladder from the full 4 GiB down, ignoring the Apple pre-cap, and report the first rung the
 * engine grants. A runtime that grants 65536 needs no cap; one that steps down does.
 */
const probeGrantedMaximum = (addStep: (step: BrowserFormatMatrixStep) => void): number | null => {
  for (const pages of LADDER_PAGES) {
    const startedAt = performance.now();
    const memory = tryReserve(pages);
    const durationMs = performance.now() - startedAt;
    addStep({
      command: `maximum=${pages} pages (${pagesToGib(pages)} GiB)`,
      durationMs,
      name: `reserve ${pagesToGib(pages)} GiB`,
      status: memory ? "succeeded" : "failed",
      timestamp: new Date().toISOString(),
      ...(memory ? {} : { error: "engine refused this maximum" }),
    });
    if (memory) return pages;
  }
  return null;
};

/**
 * How many mobile-ceiling reservations can coexist. Every warm idle runner holds one, so this is the
 * direct evidence for capping the warm-runner count. Each memory is dropped as soon as the count is
 * known.
 */
const probeCoexistence = (addStep: (step: BrowserFormatMatrixStep) => void): number => {
  const held: WebAssembly.Memory[] = [];
  const startedAt = performance.now();
  while (held.length < COEXIST_LIMIT) {
    const memory = tryReserve(COEXIST_PAGES);
    if (!memory) break;
    held.push(memory);
  }
  const durationMs = performance.now() - startedAt;
  const count = held.length;
  // Drop every reference before reporting so the probe does not leave the page holding reservations.
  held.length = 0;
  addStep({
    command: `${count}/${COEXIST_LIMIT} reservations of ${pagesToGib(COEXIST_PAGES)} GiB coexisted`,
    durationMs,
    name: "coexisting reservations at the mobile ceiling",
    status: count > 0 ? "succeeded" : "failed",
    timestamp: new Date().toISOString(),
    ...(count > 0 ? {} : { error: "could not reserve even one" }),
  });
  return count;
};

export function runBrowserSharedMemoryProbe(callbacks: {
  onStep: (step: BrowserFormatMatrixStep) => void;
}): Promise<BrowserFormatMatrixSummary> {
  const steps: BrowserFormatMatrixStep[] = [];
  const addStep = (step: BrowserFormatMatrixStep) => {
    steps.push(step);
    callbacks.onStep(step);
  };
  const startedAt = performance.now();

  const runtime = describeRuntime();
  addStep({
    command: `appleMobileWebKit=${runtime.appleMobileWebKit} mobileToken=${runtime.mobileToken} deviceMemory=${runtime.deviceMemoryGib ?? "unknown"} cores=${runtime.hardwareConcurrency ?? "unknown"}`,
    durationMs: 0,
    name: "runtime classification",
    status: "succeeded",
    timestamp: new Date().toISOString(),
  });

  const policyCapPages = resolveAppleMobileSharedMemoryMaximumPages();
  addStep({
    command: policyCapPages
      ? `current policy caps this runtime at ${policyCapPages} pages (${pagesToGib(policyCapPages)} GiB)`
      : "current policy applies no cap; this runtime requests the full 4 GiB",
    durationMs: 0,
    name: "policy in effect",
    status: "succeeded",
    timestamp: new Date().toISOString(),
  });

  const grantedMaximumPages = probeGrantedMaximum(addStep);
  const laddered = grantedMaximumPages !== null && grantedMaximumPages < FULL_MAXIMUM_PAGES;
  const coexistingAtMobileCeiling = probeCoexistence(addStep);

  // The verdict the probe exists to produce. A runtime that steps down but gets no cap is asking for
  // a reservation the engine will refuse; one that grants the full range but is capped is being
  // limited for no reason.
  const capNeeded = laddered || grantedMaximumPages === null;
  const capApplied = policyCapPages !== undefined;
  addStep({
    command: `granted=${grantedMaximumPages ?? "none"} laddered=${laddered} capApplied=${capApplied} capNeeded=${capNeeded} coexisting=${coexistingAtMobileCeiling}`,
    durationMs: 0,
    name:
      capNeeded === capApplied ? "verdict: policy matches this engine" : "verdict: POLICY DISAGREES WITH THIS ENGINE",
    status: capNeeded === capApplied ? "succeeded" : "failed",
    timestamp: new Date().toISOString(),
    ...(capNeeded === capApplied
      ? {}
      : {
          error: capNeeded
            ? "engine refuses the full maximum but receives no cap"
            : "engine grants the full maximum but is capped anyway",
        }),
  });

  const report: SharedMemoryProbeReport = {
    coexistingAtMobileCeiling,
    grantedMaximumPages,
    laddered,
    policyCapPages,
    runtime,
  };
  // Reachable from the page's downloadable report without widening the shared summary type.
  (globalThis as { ROM_WEAVER_SHARED_MEMORY_PROBE?: SharedMemoryProbeReport }).ROM_WEAVER_SHARED_MEMORY_PROBE = report;

  return Promise.resolve({
    durationMs: performance.now() - startedAt,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    passedSteps: steps.filter((step) => step.status === "succeeded").length,
    steps,
  });
}
