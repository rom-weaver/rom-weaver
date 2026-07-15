/**
 * Preview of the workflow steps that appear once files are staged. Desktop
 * shows the decorative card silhouettes; mobile condenses them to one line.
 */
type GhostStep = {
  num: string;
  title: string;
};

const GhostSteps = ({ steps }: { steps: readonly GhostStep[] }) => (
  <div className="ghost-steps">
    <p className="ghost-next">
      <span className="ghost-next-label">Next:</span>
      {steps.map((step, index) => (
        <span className="ghost-next-step" key={step.num}>
          {index > 0 ? (
            <span aria-hidden="true" className="ghost-next-arrow">
              →
            </span>
          ) : null}
          <span className="ghost-next-num mono">{step.num}</span>
          <span className="ghost-next-title">{step.title}</span>
        </span>
      ))}
    </p>
    {steps.map((step) => (
      <div aria-hidden="true" className="ghost-step" key={step.num}>
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
