/**
 * Entry script for the standalone `mobile-safari-matrix.html` on-device
 * DIAGNOSTIC page. Installs `window.ROM_WEAVER_IOS_SAFARI_MATRIX` and drives the
 * format matrix harness (`../wasm/browser-format-matrix.ts`) on real iOS Safari
 * / WebKit. Not imported by the app.
 */

import { getInterruptedArchiveStressCase, runBrowserArchiveStress } from "../wasm/browser-archive-stress.ts";
import {
  type BrowserFormatMatrixProfile,
  type BrowserFormatMatrixStep,
  type BrowserFormatMatrixSummary,
  runBrowserFullFormatMatrix,
  summarizeBrowserFormatMatrixResult,
} from "../wasm/browser-format-matrix.ts";
import { runBrowserThreadSweep } from "../wasm/browser-thread-sweep.ts";
import type { RomWeaverRunJsonEvent } from "../wasm/rom-weaver-types.d.ts";
import { type BrowserRuntimeDiagnostics, collectBrowserRuntimeDiagnostics } from "./browser-runtime-diagnostics.ts";

type MobileSafariMatrixStatus = "idle" | "running" | "passed" | "failed" | "diagnostics failed";
type MobileSafariMatrixProfile = BrowserFormatMatrixProfile | "stress" | "threads";

type MobileSafariMatrixState = {
  diagnostics: BrowserRuntimeDiagnostics | null;
  finishedAt: string | null;
  lastEvent: RomWeaverRunJsonEvent | null;
  profile: MobileSafariMatrixProfile;
  result: BrowserFormatMatrixSummary | null;
  startedAt: string | null;
  status: MobileSafariMatrixStatus;
  steps: BrowserFormatMatrixStep[];
};

type MobileSafariMatrixApi = {
  collectDiagnostics: () => Promise<BrowserRuntimeDiagnostics>;
  copyReport: () => Promise<void>;
  getReport: () => {
    diagnostics: BrowserRuntimeDiagnostics | null;
    finishedAt: string | null;
    lastEvent: RomWeaverRunJsonEvent | null;
    profile: MobileSafariMatrixProfile;
    result: BrowserFormatMatrixSummary | null;
    startedAt: string | null;
    status: MobileSafariMatrixStatus;
    steps: BrowserFormatMatrixStep[];
    version: number;
  };
  run: (profile?: MobileSafariMatrixProfile) => Promise<void>;
};

declare global {
  interface Window {
    ROM_WEAVER_IOS_SAFARI_MATRIX?: MobileSafariMatrixApi;
  }
}

const MAX_LOG_LINES = 220;
const summaryElement = document.getElementById("matrix-summary");
const logElement = document.getElementById("matrix-log");
const runButton = document.getElementById("matrix-run");
const exhaustiveButton = document.getElementById("matrix-run-exhaustive");
const stressButton = document.getElementById("matrix-run-stress");
const threadsButton = document.getElementById("matrix-run-threads");
const copyButton = document.getElementById("matrix-copy");
const downloadButton = document.getElementById("matrix-download");

const MOBILE_SAFARI_MATRIX_PROFILES: readonly MobileSafariMatrixProfile[] = ["exhaustive", "fast", "stress", "threads"];

const readProfileFromLocation = (): MobileSafariMatrixProfile => {
  const requested = new URLSearchParams(location.search).get("profile");
  const match = MOBILE_SAFARI_MATRIX_PROFILES.find((profile) => profile === requested);
  return match ?? "fast";
};

const state: MobileSafariMatrixState = {
  diagnostics: null,
  finishedAt: null,
  lastEvent: null,
  profile: readProfileFromLocation(),
  result: null,
  startedAt: null,
  status: "idle",
  steps: [],
};
const logLines: string[] = [];

const importantDiagnosticFields: Array<[string, (diagnostics: BrowserRuntimeDiagnostics) => boolean]> = [
  ["Secure context", (diagnostics) => diagnostics.isSecureContext],
  ["Isolated", (diagnostics) => diagnostics.crossOriginIsolated],
  ["SharedArrayBuffer", (diagnostics) => diagnostics.sharedArrayBuffer === "function"],
  ["Atomics.waitAsync", (diagnostics) => diagnostics.atomicsWaitAsync === "function"],
  ["OPFS", (diagnostics) => diagnostics.opfs?.available === true && diagnostics.opfs?.ok === true],
  ["WebAssembly", (diagnostics) => diagnostics.webAssembly === "object"],
  ["Worker", (diagnostics) => diagnostics.worker === "function"],
];

const appendLog = (line: string) => {
  // No wall-clock prefix: each step already carries its own duration, and the
  // narrow phone viewport is better spent on the step detail.
  logLines.push(line);
  while (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (logElement) {
    logElement.textContent = logLines.join("\n");
    if (state.startedAt && !state.finishedAt) logElement.scrollTop = logElement.scrollHeight;
  }
};

const formatDuration = (milliseconds?: number | null) => {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

const renderMetric = (label: string, value: unknown) => {
  const item = document.createElement("div");
  item.className = "metric";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const body = document.createElement("span");
  body.textContent = String(value);
  item.append(heading, body);
  return item;
};

const renderSummary = () => {
  if (!summaryElement) return;
  summaryElement.textContent = "";
  const diagnostics = state.diagnostics;
  const result = state.result;
  summaryElement.append(
    renderMetric("Status", state.status),
    renderMetric("Profile", state.profile),
    renderMetric("Passed steps", result?.passedSteps ?? 0),
    renderMetric("Failed steps", result?.failedSteps ?? 0),
    renderMetric("Duration", result ? formatDuration(result.durationMs) : ""),
  );
  if (diagnostics) {
    summaryElement.append(
      renderMetric("Mobile Safari", diagnostics.mobileSafariCandidate ? "yes" : "no"),
      renderMetric("Secure", diagnostics.isSecureContext ? "yes" : "no"),
      renderMetric("Isolated", diagnostics.crossOriginIsolated ? "yes" : "no"),
      renderMetric("OPFS", diagnostics.opfs?.ok ? "ok" : "blocked"),
    );
  }
};

const collectAndRenderDiagnostics = async () => {
  state.diagnostics = await collectBrowserRuntimeDiagnostics();
  renderSummary();
  appendLog(`diagnostics ${JSON.stringify(diagnosticSummary(state.diagnostics))}`);
  return state.diagnostics;
};

const diagnosticSummary = (diagnostics: BrowserRuntimeDiagnostics) => ({
  atomicsWaitAsync: diagnostics.atomicsWaitAsync,
  crossOriginEmbedderPolicy: diagnostics.headers?.crossOriginEmbedderPolicy ?? null,
  crossOriginIsolated: diagnostics.crossOriginIsolated,
  crossOriginOpenerPolicy: diagnostics.headers?.crossOriginOpenerPolicy ?? null,
  isSecureContext: diagnostics.isSecureContext,
  mobileSafariCandidate: diagnostics.mobileSafariCandidate,
  opfs: diagnostics.opfs,
  sharedArrayBuffer: diagnostics.sharedArrayBuffer,
});

const getDiagnosticFailures = (diagnostics: BrowserRuntimeDiagnostics) => {
  const failures: string[] = [];
  for (const [label, passes] of importantDiagnosticFields) {
    if (!passes(diagnostics)) failures.push(label);
  }
  return failures;
};

const copyReport = async () => {
  const report = getReport();
  const text = JSON.stringify(report, null, 2);
  await navigator.clipboard.writeText(text);
  appendLog("report copied");
};

const getReport = () => ({
  diagnostics: state.diagnostics,
  finishedAt: state.finishedAt,
  lastEvent: state.lastEvent,
  profile: state.profile,
  result: state.result,
  startedAt: state.startedAt,
  status: state.status,
  steps: state.steps,
  version: 1,
});

const downloadReport = () => {
  const blob = new Blob([JSON.stringify(getReport(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = `rom-weaver-${state.profile}-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.href = url;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  appendLog("report downloaded");
};

const setRunning = (running: boolean) => {
  if (runButton instanceof HTMLButtonElement) runButton.disabled = running;
  if (exhaustiveButton instanceof HTMLButtonElement) exhaustiveButton.disabled = running;
  if (stressButton instanceof HTMLButtonElement) stressButton.disabled = running;
  if (threadsButton instanceof HTMLButtonElement) threadsButton.disabled = running;
  if (copyButton instanceof HTMLButtonElement) copyButton.disabled = running || !state.result;
  if (downloadButton instanceof HTMLButtonElement) downloadButton.disabled = running || !state.result;
};

let wakeLockSentinel: WakeLockSentinel | null = null;

const releaseWakeLock = async () => {
  const sentinel = wakeLockSentinel;
  wakeLockSentinel = null;
  if (!sentinel || sentinel.released) return;
  await sentinel.release().catch(() => undefined);
  appendLog("wake lock released");
};

const acquireWakeLock = async () => {
  if (wakeLockSentinel || state.status !== "running" || document.visibilityState !== "visible") return;
  if (!navigator.wakeLock?.request) {
    appendLog("wake lock unavailable; keep this page visible");
    return;
  }
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (state.status !== "running") {
      await sentinel.release().catch(() => undefined);
      return;
    }
    wakeLockSentinel = sentinel;
    sentinel.addEventListener(
      "release",
      () => {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
        if (state.status === "running" && document.visibilityState === "visible") void acquireWakeLock();
      },
      { once: true },
    );
    appendLog("wake lock acquired");
  } catch (error) {
    appendLog(`wake lock failed ${error instanceof Error ? error.message : String(error)}`);
  }
};

type MobileSafariMatrixCallbacks = {
  onEvent: (event: RomWeaverRunJsonEvent) => void;
  onStep: (step: BrowserFormatMatrixStep) => void;
};

const runProfile = async (
  profile: MobileSafariMatrixProfile,
  callbacks: MobileSafariMatrixCallbacks,
): Promise<BrowserFormatMatrixSummary> => {
  if (profile === "stress") return runBrowserArchiveStress({ ...callbacks, caseIds: readStressCaseIdsFromLocation() });
  if (profile === "threads") return runBrowserThreadSweep(callbacks);
  return runBrowserFullFormatMatrix({ ...callbacks, prefix: "rom-weaver-ios-safari-matrix-", profile });
};

/** `?cases=many-entries,budget-200` narrows the stress profile to specific corpus cases. */
const readStressCaseIdsFromLocation = (): string[] =>
  (new URLSearchParams(location.search).get("cases") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const runMatrix = async (profile: MobileSafariMatrixProfile = "fast") => {
  state.profile = profile;
  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastEvent = null;
  state.result = null;
  state.steps = [];
  logLines.length = 0;
  setRunning(true);
  renderSummary();
  appendLog(`starting ${profile} matrix`);

  try {
    await acquireWakeLock();
    const diagnostics = await collectAndRenderDiagnostics();
    const failures = getDiagnosticFailures(diagnostics);
    if (failures.length > 0) {
      throw new Error(`Runtime preflight failed: ${failures.join(", ")}`);
    }

    const callbacks: MobileSafariMatrixCallbacks = {
      onEvent(event: RomWeaverRunJsonEvent) {
        state.lastEvent = event;
      },
      onStep(step: BrowserFormatMatrixStep) {
        state.steps.push(step);
        if (step.status === "running") {
          appendLog(`run ${step.name}`);
          return;
        }
        // Only worth printing when it disagrees with the step status; the sweep
        // reports both as "succeeded" and the pair reads as noise.
        const status =
          step.terminalStatus && step.terminalStatus !== step.status
            ? `${step.status}/${step.terminalStatus}`
            : step.status;
        // `command` carries the per-step detail the harness measured (for the
        // thread sweep, the actual thread counts), so it has to reach the log.
        const detail = [step.command, step.error].filter(Boolean).join(" ");
        appendLog(`${status} ${step.name} ${formatDuration(step.durationMs)}${detail ? ` ${detail}` : ""}`);
      },
    };
    state.result = await runProfile(profile, callbacks);
    // A profile that records failures instead of throwing (the thread sweep,
    // so one bad count cannot discard the rest) still resolves, so the verdict
    // has to come from the tally rather than from "did it reject".
    const passed = state.result.failedSteps === 0;
    state.status = passed ? "passed" : "failed";
    appendLog(`matrix ${passed ? "passed" : "failed"} ${summarizeBrowserFormatMatrixResult(state.result)}`);
  } catch (error) {
    state.status = "failed";
    state.result = state.result || {
      durationMs: state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0,
      failedSteps: 1,
      passedSteps: state.steps.filter((step) => step.status === "succeeded").length,
      steps: state.steps,
    };
    appendLog(`failed ${error instanceof Error ? error.message : String(error)}`);
    console.error(error);
  } finally {
    await releaseWakeLock();
    state.finishedAt = new Date().toISOString();
    setRunning(false);
    renderSummary();
  }
};

document.addEventListener("visibilitychange", () => {
  if (state.status === "running" && document.visibilityState === "visible") void acquireWakeLock();
});

runButton?.addEventListener("click", () => {
  runMatrix("fast");
});
exhaustiveButton?.addEventListener("click", () => {
  runMatrix("exhaustive");
});
stressButton?.addEventListener("click", () => {
  runMatrix("stress");
});
threadsButton?.addEventListener("click", () => {
  runMatrix("threads");
});
copyButton?.addEventListener("click", () => {
  copyReport().catch((error) => {
    appendLog(`copy failed ${error instanceof Error ? error.message : String(error)}`);
  });
});
downloadButton?.addEventListener("click", downloadReport);

window.ROM_WEAVER_IOS_SAFARI_MATRIX = {
  collectDiagnostics: collectAndRenderDiagnostics,
  copyReport,
  getReport,
  run: runMatrix,
};

const interrupted = getInterruptedArchiveStressCase();
if (interrupted) {
  state.profile = "stress";
  state.status = "failed";
  state.result = {
    durationMs: Math.max(0, Date.now() - Date.parse(interrupted.startedAt)),
    failedSteps: 1,
    passedSteps: 0,
    steps: [
      {
        command: "extract",
        error: "The page was reloaded or terminated before the case finished",
        name: interrupted.id,
        status: "failed",
        timestamp: new Date().toISOString(),
      },
    ],
  };
  state.steps = state.result.steps;
  appendLog(`interrupted archive case detected: ${interrupted.id}`);
  setRunning(false);
  renderSummary();
}

collectAndRenderDiagnostics().catch((error) => {
  state.status = "diagnostics failed";
  appendLog(`diagnostics failed ${error instanceof Error ? error.message : String(error)}`);
  renderSummary();
});
