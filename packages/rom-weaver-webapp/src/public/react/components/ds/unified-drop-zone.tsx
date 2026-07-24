import { type ReactNode, useRef } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { markDropReceived } from "../../../../lib/perf/op-perf-marks.ts";
import type { MessageId } from "../../../../presentation/localization/catalog.ts";
import { useUiLocalizer } from "../../settings-context.tsx";
import { DropZone, InfoPopover, StepSection } from "./layout.tsx";

/**
 * The 0x01 INPUTS step - the single combined drop surface shared by every
 * workflow tab. A hero drop target while the form is empty, shrinking to the
 * compact add-row once files are staged. Always accepts multiple files,
 * traces what it receives, and lists every supported format. Routing is decided
 * by the per-tab caller (see `unified-drop-routing.ts`).
 */

const logger = createLogger("unified-drop-zone");

type SupportedFileGroup = {
  label: string;
  extensions: readonly string[];
};

type UnifiedDropZoneProps = {
  /** Compact add-row label once files are staged. */
  addLabel: ReactNode;
  /** Hero (empty-state) drop instruction; `heroLabelCoarse` is the touch variant. */
  heroLabel: ReactNode;
  heroLabelCoarse: ReactNode;
  big?: boolean;
  disabled?: boolean;
  accept?: string;
  id?: string;
  inputId?: string;
  /** Extra content for the step-header info popover (above the supported-file lists). */
  info?: ReactNode;
  /** Full per-bucket extension support, listed in the hero ticker and info popover. */
  supported?: readonly SupportedFileGroup[];
  /** Per-workflow thesis lines for the empty-state lead (defaults to the apply copy). */
  lead?: { line1: MessageId; line2: MessageId };
  showLeadAccent?: boolean;
  /** Step number/title; the inputs step is 0x01 in every workflow. */
  num?: string;
  title?: ReactNode;
  /** Right-aligned control sharing the 0x01 header row. */
  headerExtra?: ReactNode;
  /** Fires at the drop gesture, before files enter routing or staging. */
  onDropStart?: () => void;
  onFiles: (files: File[]) => void;
  /** Extra content rendered inside the 0x01 step body, below the drop target (e.g. the
   * "identifying…" placeholders for dropped archives) so it shares the step's content width. */
  afterDropZone?: ReactNode;
};

const UnifiedDropZone = ({
  addLabel,
  afterDropZone,
  headerExtra,
  heroLabel,
  heroLabelCoarse,
  info,
  lead = { line1: "ui.hero.thesis", line2: "ui.hero.thesis2" },
  num = "0x01",
  onDropStart,
  onFiles,
  showLeadAccent = true,
  supported,
  title = "Inputs",
  ...dropZoneProps
}: UnifiedDropZoneProps) => {
  const localizer = useUiLocalizer();
  const inputRef = useRef<HTMLInputElement>(null);
  const big = Boolean(dropZoneProps.big);
  const emit = (files: File[]) => {
    // Open the perceived-latency window: a drop/selection just began, measured against the first wasm
    // progress event (see lib/perf/op-perf-marks.ts → romweaver:before-start).
    markDropReceived();
    logger.trace("unified drop zone received files", {
      count: files.length,
      names: files.map((file) => file.name),
    });
    onFiles(files);
  };
  const formats = [...new Set(supported?.flatMap((group) => group.extensions) || [])];
  const popover =
    info || supported?.length ? (
      <InfoPopover title="Input handling">
        {info}
        {supported?.length ? (
          <div className="info-support">
            {supported.map((group) => (
              <p key={group.label}>
                <b>{group.label}</b> <span className="mono">{group.extensions.join(", ")}</span>
              </p>
            ))}
          </div>
        ) : null}
      </InfoPopover>
    ) : undefined;
  const heroLead = big ? (
    <div className="hero-lead">
      <span className="lead-title">
        <span className="lead-line">{localizer.message(lead.line1)}</span>{" "}
        <span className="lead-line">
          {localizer.message(lead.line2)}
          {showLeadAccent ? (
            <>
              {" "}
              <span className="lead-accent">{localizer.message("ui.hero.accent")}</span>
            </>
          ) : null}
          .
        </span>
      </span>
      <span className="lead-sub mono">{localizer.message("ui.hero.local")}</span>
    </div>
  ) : undefined;
  return (
    <StepSection
      className={big ? "is-input is-empty unified-drop-step unified-drop-step--hero" : "is-input unified-drop-step"}
      headerAction={{
        disabled: dropZoneProps.disabled,
        label: "Add files",
        onClick: () => inputRef.current?.click(),
      }}
      headerExtra={headerExtra}
      info={popover}
      num={num}
      title={title}
    >
      <DropZone
        {...dropZoneProps}
        bare
        formats={formats}
        hintCoarse={big ? undefined : localizer.message("ui.drop.tap")}
        inputRef={inputRef}
        label={big ? heroLabel : addLabel}
        labelCoarse={big ? heroLabelCoarse : undefined}
        lead={heroLead}
        multiple
        onDropStart={onDropStart}
        onFiles={emit}
      />
      {afterDropZone}
    </StepSection>
  );
};

export { UnifiedDropZone };
