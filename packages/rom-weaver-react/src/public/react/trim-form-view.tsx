import type { ComponentProps, ReactNode } from "react";
import { NeedsInput, StepSection } from "./components/ds/layout.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";

/**
 * Presentational shell for the trim workflow. The stateful TrimPatchForm
 * controller builds these prop bundles and hands them over; the view owns only
 * layout — the page section, the unified drop zone, the empty vs. staged source
 * branch, the output step and the trim confirmation. Keeping the markup here
 * lets it be exercised inert (a11y / state galleries) without booting the
 * workflow, wasm or worker pool.
 */
type TrimPatchFormViewModel = {
  /** Trim confirmation dialog (driven open by the controller). */
  confirm: ComponentProps<typeof ConfirmDialog>;
  /** Active candidate-selection dialog (or nothing). */
  dialog?: ReactNode;
  /** Unified ROM/archive drop zone (step 0x01). */
  dropZone: ComponentProps<typeof UnifiedDropZone>;
  /** Forwards the "needs input" prompt to the unified picker. */
  onAddInput: () => void;
  /** Output step (0x03): filename, output format, compression, run action. */
  output: ComponentProps<typeof WorkflowOutputStep>;
  /** No source staged yet — show the prompt instead of the card. */
  sourceEmpty: boolean;
  /** ROM source step (0x02). */
  sourceStep: ComponentProps<typeof WorkflowRomInputStep>;
};

const TrimPatchFormView = ({
  confirm,
  dialog,
  dropZone,
  onAddInput,
  output,
  sourceEmpty,
  sourceStep,
}: TrimPatchFormViewModel) => (
  <section className="panel" id="trim-builder-container">
    <UnifiedDropZone {...dropZone} />
    {sourceEmpty ? (
      <StepSection num="0x02" title="ROM">
        <NeedsInput onClick={onAddInput}>
          Add a ROM in <b className="hexref mono">0x01</b> above
        </NeedsInput>
      </StepSection>
    ) : (
      <WorkflowRomInputStep {...sourceStep} />
    )}
    <WorkflowOutputStep {...output} />
    <ConfirmDialog {...confirm} />
    {dialog}
  </section>
);

export { TrimPatchFormView, type TrimPatchFormViewModel };
