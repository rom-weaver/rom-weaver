import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApplyPatchForm, RomWeaverSettingsProvider } from "../public/react/index.tsx";
import "./style.css";

const rootElement = document.getElementById("webapp-root");
if (!rootElement) throw new Error("Missing #webapp-root mount node");

createRoot(rootElement).render(
  <StrictMode>
    <RomWeaverSettingsProvider>
      <div className="mx-auto min-h-screen w-full max-w-[1480px] px-3 py-4 xl:px-6 xl:py-6">
        <ApplyPatchForm />
      </div>
    </RomWeaverSettingsProvider>
  </StrictMode>,
);
