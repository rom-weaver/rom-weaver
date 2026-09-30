import { Monitor, MonitorCheck, MonitorX } from "lucide-react";
import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { BrowserApplyResult } from "../../platform/browser/browser-api.ts";
import {
  closeBootCheckAudioContext,
  releaseBootCheckAudioContext,
  restoreBootCheckAudioContext,
  takeBootCheckAudioContext,
} from "./boot-check-audio.ts";
import { runEmulatorBootCheck, type BootCheckOutcome } from "./components/emulator-boot-check.ts";
import { loadEmulatorRom } from "./components/emulator-load-rom.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import { setVerifyBootAfterApplyOverride, useVerifyBootAfterApplyValue } from "./use-apply-download-orchestration.ts";
import { useLatestRef } from "./use-latest-ref.ts";

const logger = createLogger("apply-boot-check");
const BOOT_CHECK_TIMEOUT_MS = 15_000;

type ApplyOutput = BrowserApplyResult["output"];
type BootCheckState = BootCheckOutcome | { message: string; status: "error" } | { status: "checking" };
type BootCheckResult = Exclude<BootCheckState, { status: "checking" }>;

/**
 * Finished checks, keyed by the Apply output they describe. A remounted
 * Apply view shows the stored result instead of booting the output again.
 */
const finishedChecks = new WeakMap<ApplyOutput, BootCheckResult>();

const emulatorDataUrl = () =>
  typeof document === "undefined" ? "/emulatorjs/data/" : new URL("emulatorjs/data/", document.baseURI).href;

const isAbort = (error: unknown, signal: AbortSignal) =>
  signal.aborted || (error instanceof Error && error.name === "AbortError");

/** Boot the output once, and cancel the check when the output goes away. */
const useBootCheck = (core: string | undefined, enabled: boolean, output: ApplyOutput | null | undefined) => {
  // A ref, because a language change MUST NOT boot the output again.
  const localizerRef = useLatestRef(useUiLocalizer());
  const [state, setState] = useState<BootCheckState | null>(null);
  useEffect(() => {
    if (!output) {
      setState(null);
      return undefined;
    }
    if (!(enabled && core)) {
      // Apply made a context for a check that will not run.
      releaseBootCheckAudioContext();
      setState(null);
      return undefined;
    }
    const finished = finishedChecks.get(output);
    if (finished) {
      setState(finished);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const audioContext = takeBootCheckAudioContext();
    let handedToPlayer = false;
    setState({ status: "checking" });
    const run = async (): Promise<BootCheckResult> => {
      const blob = await output.getBlob?.();
      if (!blob) throw new Error(localizerRef.current.message("ui.apply.emulator.unavailableOutput"));
      const loaded = await loadEmulatorRom(blob, output.fileName, { signal });
      handedToPlayer = true;
      return runEmulatorBootCheck({
        audioContext,
        checksum: loaded.checksum,
        core,
        dataUrl: emulatorDataUrl(),
        fileName: loaded.fileName,
        rom: loaded.blob,
        signal,
        timeoutMs: BOOT_CHECK_TIMEOUT_MS,
      });
    };
    void run()
      .then((result) => {
        logger.debug("Boot check finished", { core, fileName: output.fileName, status: result.status });
        finishedChecks.set(output, result);
        if (!signal.aborted) setState(result);
      })
      .catch((error: unknown) => {
        if (isAbort(error, signal)) {
          logger.trace("Boot check cancelled", { core, fileName: output.fileName });
          return;
        }
        const message = error instanceof Error ? error.message : String(error || "");
        logger.warn("Boot check could not run", { core, fileName: output.fileName, message });
        const result = { message, status: "error" as const };
        finishedChecks.set(output, result);
        setState(result);
      })
      .finally(() => {
        if (!audioContext) return;
        if (signal.aborted && !handedToPlayer) restoreBootCheckAudioContext(audioContext);
        else closeBootCheckAudioContext(audioContext);
      });
    return () => controller.abort();
  }, [core, enabled, localizerRef, output]);
  return state;
};

/** The Apply option. Like Post Apply Test, a change here lasts for this session only. */
export const VerifyBootField = ({ disabled, setting }: { disabled: boolean; setting: unknown }) => {
  const localizer = useUiLocalizer();
  const checked = useVerifyBootAfterApplyValue(setting);
  return (
    <div className="verify-boot-field">
      <label className="checkrow" htmlFor="rom-weaver-checkbox-verify-boot">
        <input
          aria-describedby="rom-weaver-verify-boot-hint"
          checked={checked}
          disabled={disabled}
          id="rom-weaver-checkbox-verify-boot"
          onChange={(event) => setVerifyBootAfterApplyOverride(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{localizer.message("ui.apply.verifyBoot.label")}</span>
      </label>
      <p className="verify-boot-hint" id="rom-weaver-verify-boot-hint">
        {localizer.message("ui.apply.verifyBoot.hint")}
      </p>
    </div>
  );
};

const describeResult = (
  state: BootCheckState,
  localizer: ReturnType<typeof useUiLocalizer>,
): { label: string; note?: string } => {
  if (state.status === "checking") return { label: localizer.message("ui.apply.verifyBoot.checking") };
  if (state.status === "boots") return { label: localizer.message("ui.apply.verifyBoot.boots") };
  if (state.status === "error") {
    return { label: localizer.message("ui.apply.verifyBoot.error", { message: state.message }) };
  }
  const label = localizer.message("ui.apply.verifyBoot.blank");
  if (state.reason === "timeout") {
    const seconds = Math.round(BOOT_CHECK_TIMEOUT_MS / 1000);
    return { label, note: localizer.message("ui.apply.verifyBoot.timeout", { seconds }) };
  }
  if (state.reason === "failed-to-start") {
    return { label, note: localizer.message("ui.apply.verifyBoot.failedToStart") };
  }
  return { label };
};

const STATUS_ICONS = {
  blank: MonitorX,
  boots: MonitorCheck,
  checking: Monitor,
  error: MonitorX,
} as const;

/** The boot check outcome, shown under the Post Apply Test control. */
export const BootCheckStatus = ({
  core,
  enabled,
  output,
}: {
  core: string | undefined;
  enabled: boolean;
  output?: ApplyOutput | null;
}) => {
  const localizer = useUiLocalizer();
  const state = useBootCheck(core, enabled, output);
  if (!state) return null;
  const { label, note } = describeResult(state, localizer);
  const Icon = STATUS_ICONS[state.status];
  return (
    <p aria-live="polite" className="boot-check" data-state={state.status} id="rom-weaver-boot-check" role="status">
      <Icon aria-hidden="true" />
      <span className="boot-check-label">{label}</span>
      {note ? <span className="boot-check-note">{note}</span> : null}
    </p>
  );
};
