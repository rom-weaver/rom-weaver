/**
 * Faint, non-interactive preview of the workflow steps that appear once files
 * are staged. Rendered only while the bench is empty so the 0x01 hero reads as
 * step one of a visible sequence instead of a lone panel in the void. Purely
 * decorative: aria-hidden, no focus targets, swapped for the real steps by the
 * same crossfade that shrinks the hero.
 */
type GhostStep = {
  num: string;
  title: string;
};

const GhostSteps = ({ steps }: { steps: readonly GhostStep[] }) => (
  <div aria-hidden="true" className="ghost-steps">
    {steps.map((step) => (
      <div className="ghost-step" key={step.num}>
        <div className="ghost-step-head">
          <span className="ghost-step-num mono">{step.num}</span>
          <span className="ghost-step-title">{step.title}</span>
        </div>
        <div className="ghost-step-body">
          <div className="ghost-step-slot">
            <div className="ghost-slot-lines">
              <span className="ghost-line name" />
              <span className="ghost-line sub" />
            </div>
            <span className="ghost-slot-btn" />
          </div>
        </div>
      </div>
    ))}
  </div>
);

export { GhostSteps };
