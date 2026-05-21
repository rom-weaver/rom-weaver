import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApplyPatchForm, RomWeaverSettingsProvider } from "../public/react/index.tsx";
import "./style.css";

const defaultDebugSettings = {
  logging: {
    level: "trace" as const,
    sink: (record: {
      details?: Record<string, unknown>;
      level: "debug" | "error" | "info" | "trace" | "warn";
      message: string;
      namespace: string;
      timestamp: string;
    }) => {
      if (typeof console === "undefined") return;
      const method =
        record.level === "error"
          ? console.error
          : record.level === "warn"
            ? console.warn
            : record.level === "info"
              ? console.info
              : console.debug;
      const stderrLine =
        record.level === "trace" &&
        record.namespace === "runtime:rom-weaver" &&
        record.message === "rom-weaver.stderr" &&
        typeof record.details?.line === "string"
          ? record.details.line.trim()
          : "";
      if (stderrLine) {
        method.call(console, `${record.timestamp} TRACE runtime:rom-weaver: ${stderrLine}`);
        return;
      }
      const line = `${record.timestamp} ${record.level.toUpperCase()} ${record.namespace}: ${record.message}`;
      const details = record.details && Object.keys(record.details).length ? record.details : undefined;
      if (details) method.call(console, line, details);
      else method.call(console, line);
    },
  },
};

const rootElement = document.getElementById("webapp-root");
if (!rootElement) throw new Error("Missing #webapp-root mount node");

createRoot(rootElement).render(
  <StrictMode>
    <RomWeaverSettingsProvider settings={defaultDebugSettings}>
      <div className="mx-auto min-h-screen w-full max-w-[1480px] px-3 py-4 xl:px-6 xl:py-6">
        <ApplyPatchForm />
      </div>
    </RomWeaverSettingsProvider>
  </StrictMode>,
);
