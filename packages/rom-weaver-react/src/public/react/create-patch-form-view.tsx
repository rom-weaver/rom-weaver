import type { ComponentProps, ReactNode } from "react";
import { NeedsInput, StepSection } from "./components/ds/layout.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";

/**
 * Presentational shell for the create-patch workflow. The stateful
 * CreatePatchForm controller builds these prop bundles and hands them over; the
 * view owns nothing but layout — the page section, the unified drop zone, the
 * empty vs. staged source branch, the swap row, the output step and any active
 * dialog. Keeping the markup here lets it be exercised inert (a11y / state
 * galleries) without booting the workflow, wasm or worker pool.
 */
type CreatePatchFormViewModel = {
  /** Active candidate-selection dialog (or nothing). */
  dialog?: ReactNode;
  /** Unified ROM/archive drop zone (step 0x01). */
  dropZone: ComponentProps<typeof UnifiedDropZone>;
  /** Modified source step (0x03). */
  modifiedStep: ComponentProps<typeof WorkflowRomInputStep>;
  /** Forwards "needs input" prompts to the unified picker. */
  onAddInput: () => void;
  /** Original source step (0x02). */
  originalStep: ComponentProps<typeof WorkflowRomInputStep>;
  /** Output step (0x04): patch type, filename, compression, run action. */
  output: ComponentProps<typeof WorkflowOutputStep>;
  /** No source staged yet — show the prompts instead of the cards. */
  sourcesEmpty: boolean;
  /** Swap original/modified — present only when both sources are staged. */
  swap: { disabled: boolean; onSwap: () => void } | null;
};

const CreatePatchFormView = ({
  dialog,
  dropZone,
  modifiedStep,
  onAddInput,
  originalStep,
  output,
  sourcesEmpty,
  swap,
}: CreatePatchFormViewModel) => (
  <section className="panel" id="patch-builder-container">
    <UnifiedDropZone {...dropZone} />
    {sourcesEmpty ? (
      <>
        <StepSection num="0x02" title="Original">
          <NeedsInput onClick={onAddInput}>
            Add the original ROM in <b className="hexref mono">0x01</b> above
          </NeedsInput>
        </StepSection>
        <StepSection num="0x03" title="Modified">
          <NeedsInput onClick={onAddInput}>
            Add the modified ROM in <b className="hexref mono">0x01</b> above
          </NeedsInput>
        </StepSection>
      </>
    ) : (
      <>
        <WorkflowRomInputStep {...originalStep} />
        {swap ? (
          <div className="swap-row">
            <button
              className="btn swap-btn"
              disabled={swap.disabled}
              id="patch-builder-button-swap-sources"
              onClick={swap.onSwap}
              title="Swap original and modified"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M16 4.5 20 8.5l-4 4M20 8.5H7M8 19.5l-4-4 4-4M4 15.5h13" />
              </svg>
              Swap
            </button>
          </div>
        ) : null}
        <WorkflowRomInputStep {...modifiedStep} />
      </>
    )}
    <WorkflowOutputStep {...output} />
    {dialog}
  </section>
);

export { CreatePatchFormView, type CreatePatchFormViewModel };
