import { useEffect, useState } from "react";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { listKeptRoms } from "../../storage/browser/kept-roms.ts";
import { useUiLocalizer } from "./settings-context.tsx";

const StorageFullRecovery = ({ message, onRetry }: { message: string; onRetry?: () => void }) => {
  const localizer = useUiLocalizer();
  const [usage, setUsage] = useState<{ bytes: number; cleaned: boolean } | null>(null);
  const quotaMessage = /\b(no space left|quota|nospc|enospc|storage is full)\b|QuotaExceededError/i.test(message)
    ? message
    : "";
  useEffect(() => {
    setUsage(null);
    if (!quotaMessage) return;
    let current = true;
    let revision = 0;
    let initial: number | undefined;
    const refresh = async () => {
      const request = ++revision;
      try {
        const roms = await listKeptRoms();
        if (!current || request !== revision) return;
        const bytes = roms.reduce((total, rom) => total + (rom.status === "ready" ? rom.size : 0), 0);
        initial ??= bytes;
        if (initial > 0) setUsage({ bytes, cleaned: bytes < initial });
      } catch {
        // Storage recovery MUST preserve the job's original error if its index is unavailable.
      }
    };
    const changed = () => void refresh();
    void refresh();
    window.addEventListener("rom-weaver-kept-roms-changed", changed);
    window.addEventListener("focus", changed);
    return () => {
      current = false;
      window.removeEventListener("rom-weaver-kept-roms-changed", changed);
      window.removeEventListener("focus", changed);
    };
  }, [quotaMessage]);
  if (!(quotaMessage && usage)) return null;
  return (
    <>
      <br />
      {localizer.message("ui.storageFull.keptUsage", { size: formatByteSize(usage.bytes) })}{" "}
      <button
        className="btn slim ghost"
        type="button"
        onClick={() => window.dispatchEvent(new Event("rom-weaver-open-storage"))}
      >
        {localizer.message("ui.storageFull.openStorage")}
      </button>
      {usage.cleaned && onRetry ? (
        <button className="btn slim ghost" type="button" onClick={onRetry}>
          {localizer.message("ui.storageFull.tryAgain")}
        </button>
      ) : null}
    </>
  );
};

export { StorageFullRecovery };
