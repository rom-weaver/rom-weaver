import {
  runBrowserFullFormatMatrix,
  summarizeBrowserFormatMatrixResult,
} from "../../../rom-weaver-wasm/src/browser-format-matrix.mjs";
import { collectBrowserRuntimeDiagnostics } from "./browser-runtime-diagnostics.ts";

const MAX_LOG_LINES = 220;
const summaryElement = document.getElementById("matrix-summary");
const logElement = document.getElementById("matrix-log");
const runButton = document.getElementById("matrix-run");
const copyButton = document.getElementById("matrix-copy");

const state = {
  diagnostics: null,
  finishedAt: null,
  lastEvent: null,
  result: null,
  startedAt: null,
  status: "idle",
  steps: [],
};
const logLines = [];

const importantDiagnosticFields = [
  ["Secure context", (diagnostics) => diagnostics.isSecureContext],
  ["Isolated", (diagnostics) => diagnostics.crossOriginIsolated],
  ["SharedArrayBuffer", (diagnostics) => diagnostics.sharedArrayBuffer === "function"],
  ["Atomics.waitAsync", (diagnostics) => diagnostics.atomicsWaitAsync === "function"],
  ["OPFS", (diagnostics) => diagnostics.opfs?.available === true && diagnostics.opfs?.ok === true],
  ["WebAssembly", (diagnostics) => diagnostics.webAssembly === "object"],
  ["Worker", (diagnostics) => diagnostics.worker === "function"],
];

const appendLog = (line) => {
  const timestamp = new Date().toISOString().slice(11, 19);
  logLines.push(`${timestamp} ${line}`);
  while (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (logElement) logElement.textContent = logLines.join("\n");
};

const formatDuration = (milliseconds) => {
  if (!Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

const renderMetric = (label, value) => {
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

const diagnosticSummary = (diagnostics) => ({
  atomicsWaitAsync: diagnostics.atomicsWaitAsync,
  crossOriginEmbedderPolicy: diagnostics.headers?.crossOriginEmbedderPolicy ?? null,
  crossOriginIsolated: diagnostics.crossOriginIsolated,
  crossOriginOpenerPolicy: diagnostics.headers?.crossOriginOpenerPolicy ?? null,
  isSecureContext: diagnostics.isSecureContext,
  mobileSafariCandidate: diagnostics.mobileSafariCandidate,
  opfs: diagnostics.opfs,
  sharedArrayBuffer: diagnostics.sharedArrayBuffer,
});

const getDiagnosticFailures = (diagnostics) => {
  const failures = [];
  for (const [label, passes] of importantDiagnosticFields) {
    if (!passes(diagnostics)) failures.push(label);
  }
  return failures;
};

const copyReport = async () => {
  const report = {
    diagnostics: state.diagnostics,
    finishedAt: state.finishedAt,
    lastEvent: state.lastEvent,
    result: state.result,
    startedAt: state.startedAt,
    status: state.status,
    steps: state.steps,
  };
  const text = JSON.stringify(report, null, 2);
  await navigator.clipboard.writeText(text);
  appendLog("report copied");
};

const setRunning = (running) => {
  if (runButton) runButton.disabled = running;
  if (copyButton) copyButton.disabled = running || !state.result;
};

const runMatrix = async () => {
  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastEvent = null;
  state.result = null;
  state.steps = [];
  logLines.length = 0;
  setRunning(true);
  renderSummary();
  appendLog("starting full format and patch matrix");

  try {
    const diagnostics = await collectAndRenderDiagnostics();
    const failures = getDiagnosticFailures(diagnostics);
    if (failures.length > 0) {
      throw new Error(`Runtime preflight failed: ${failures.join(", ")}`);
    }

    state.result = await runBrowserFullFormatMatrix({
      onEvent(event) {
        state.lastEvent = event;
      },
      onStep(step) {
        state.steps.push(step);
        if (step.status === "running") {
          appendLog(`run ${step.name}`);
          return;
        }
        const status = step.terminalStatus ? `${step.status}/${step.terminalStatus}` : step.status;
        appendLog(`${status} ${step.name} ${formatDuration(step.durationMs)}`);
      },
      prefix: "rom-weaver-ios-safari-matrix-",
    });
    state.status = "passed";
    appendLog(`matrix passed ${summarizeBrowserFormatMatrixResult(state.result)}`);
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
    state.finishedAt = new Date().toISOString();
    setRunning(false);
    renderSummary();
  }
};

runButton?.addEventListener("click", () => {
  runMatrix();
});
copyButton?.addEventListener("click", () => {
  copyReport().catch((error) => {
    appendLog(`copy failed ${error instanceof Error ? error.message : String(error)}`);
  });
});

window.ROM_WEAVER_IOS_SAFARI_MATRIX = {
  collectDiagnostics: collectAndRenderDiagnostics,
  copyReport,
  getReport: () => ({
    diagnostics: state.diagnostics,
    finishedAt: state.finishedAt,
    lastEvent: state.lastEvent,
    result: state.result,
    startedAt: state.startedAt,
    status: state.status,
    steps: state.steps,
  }),
  run: runMatrix,
};

collectAndRenderDiagnostics().catch((error) => {
  state.status = "diagnostics failed";
  appendLog(`diagnostics failed ${error instanceof Error ? error.message : String(error)}`);
  renderSummary();
});
