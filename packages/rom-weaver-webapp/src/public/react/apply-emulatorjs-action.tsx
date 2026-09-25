import { Gamepad2 } from "lucide-react";
import { useState } from "react";
import type { BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import { addEntry, getApplyEntry, prepareEntry, setCurrentGame } from "./emulator-session-store.ts";
import { prepareEmulatorAudioContext, requestEmulatorStartFromUserAction } from "./emulator-audio-context.ts";
import { createEmulatorGameIdentity } from "./components/emulator-document.ts";
import { loadEmulatorRom, renameRomToOutput } from "./components/emulator-load-rom.ts";
import { useUiLocalizer } from "./settings-context.tsx";

/** Reuse the completed output for Test without requiring another file selection. */
export const EmulatorJsAction = ({
  core,
  fileName,
  onSelectView,
  output,
  platform,
  shown,
}: {
  core: string | undefined;
  fileName?: string;
  onSelectView?: (view: "test") => void;
  output?: BrowserApplyResult["output"] | null;
  platform?: string;
  shown: boolean;
}) => {
  const localizer = useUiLocalizer();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  if (!(output && shown)) return null;
  if (!core) {
    const unavailableLabel = platform?.trim()
      ? localizer.message("ui.apply.emulator.unavailablePlatform", { platform: platform.trim() })
      : localizer.message("ui.apply.emulator.unavailable");
    return (
      <div className="emulatorjs-test">
        <button className="btn play" disabled id="rom-weaver-button-test-emulator" type="button">
          <Gamepad2 aria-hidden="true" />
          <span className="play-label">{unavailableLabel}</span>
        </button>
      </div>
    );
  }
  const openInEmulator = async () => {
    setLoading(true);
    setError("");
    try {
      let retained = getApplyEntry(fileName) || getApplyEntry();
      if (retained) {
        if (!retained.checksum) {
          await prepareEntry(retained.id);
          retained = getApplyEntry(fileName) || getApplyEntry();
        }
        if (!retained?.checksum) throw new Error(localizer.message("ui.apply.emulator.missingChecksum"));
        const { gameName } = createEmulatorGameIdentity({ checksum: retained.checksum, fileName: retained.fileName });
        prepareEmulatorAudioContext(gameName);
        setCurrentGame(retained.id);
        requestEmulatorStartFromUserAction(gameName);
        onSelectView?.("test");
        return;
      }
      prepareEmulatorAudioContext();
      const blob = await output.getBlob?.();
      if (!blob) throw new Error(localizer.message("ui.apply.emulator.unavailableOutput"));
      const loaded = await loadEmulatorRom(blob, output.fileName);
      const entry = {
        blob: loaded.blob,
        checksum: loaded.checksum,
        core,
        fileName: renameRomToOutput(output.fileName, loaded.fileName),
        id: output.id,
        platform,
        sizeBytes: loaded.blob.size,
        source: "apply" as const,
      };
      addEntry(entry);
      const { gameName } = createEmulatorGameIdentity(entry);
      prepareEmulatorAudioContext(gameName);
      setCurrentGame(output.id);
      requestEmulatorStartFromUserAction(gameName);
      onSelectView?.("test");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : localizer.message("ui.apply.emulator.prepareFailed"));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="emulatorjs-test">
      <button
        aria-busy={loading}
        className="btn play"
        disabled={loading}
        id="rom-weaver-button-test-emulator"
        onClick={() => void openInEmulator()}
        type="button"
      >
        <Gamepad2 aria-hidden="true" />
        <span className="play-label">
          {loading ? localizer.message("ui.apply.emulator.preparing") : localizer.message("ui.apply.emulator.openTest")}
        </span>
        <span className="play-core mono">{core}</span>
      </button>
      {error ? (
        <p className="emulatorjs-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
