import type { ComponentProps, ReactNode } from "react";
import { GhostSteps } from "./components/ds/ghost-steps.tsx";
import { ConfirmDialog } from "./components/ds/modal.tsx";
import { UnifiedDropZone } from "./components/ds/unified-drop-zone.tsx";
import { WorkflowOutputStep } from "./components/ds/workflow-output-step.tsx";
import { WorkflowRomInputStep } from "./components/ds/workflow-rom-input-step.tsx";
import { useUiLocalizer } from "./settings-context.tsx";

/**
 * Presentational shell for the trim workflow. The stateful TrimPatchForm
 * controller builds these prop bundles and hands them over; the view owns only
 * layout - the page section, the unified drop zone, the empty vs. staged source
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
  /** Output step (0x03): filename, output format, compression, run action. */
  output: ComponentProps<typeof WorkflowOutputStep>;
  /** No source staged yet - show only the hero. */
  sourceEmpty: boolean;
  /** ROM source step (0x02). */
  sourceStep: ComponentProps<typeof WorkflowRomInputStep>;
};

const TrimPatchFormView = ({ confirm, dialog, dropZone, output, sourceEmpty, sourceStep }: TrimPatchFormViewModel) => {
  const localizer = useUiLocalizer();
  return (
    <section className="panel" id="trim-builder-container">
      <UnifiedDropZone {...dropZone} lead={{ line1: "ui.hero.trimThesis", line2: "ui.hero.trimThesis2" }} />
      {sourceEmpty ? (
        <GhostSteps
          steps={[
            { num: "0x02", title: localizer.message("ui.step.rom") },
            { num: "0x03", title: localizer.message("ui.step.output") },
          ]}
        />
      ) : (
        <>
          <WorkflowRomInputStep {...sourceStep} />
          <WorkflowOutputStep {...output} />
        </>
      )}
      <ConfirmDialog {...confirm} />
      {dialog}
    </section>
  );
};

export { TrimPatchFormView, type TrimPatchFormViewModel };
