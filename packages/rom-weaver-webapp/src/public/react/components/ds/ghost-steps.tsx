/**
 * Preview of the workflow steps that appear once files are staged: a single
 * "Next:" line of hex step numbers and titles, shared by every viewport.
 */
type GhostStep = {
  num: string;
  title: string;
};

const GhostSteps = ({ steps }: { steps: readonly GhostStep[] }) => (
  <div className="ghost-steps">
    {/* input steps join with "+"; the arrow marks the final step they flow
        into (0x02 ROM + 0x03 Patches → 0x04 Apply) */}
    <p className="ghost-next">
      <span className="ghost-next-label">Next:</span>
      {steps.map((step, index) => (
        <span className="ghost-next-step" key={step.num}>
          {index > 0 ? (
            <span aria-hidden="true" className="ghost-next-arrow">
              {index === steps.length - 1 ? "→" : "+"}
            </span>
          ) : null}
          <span className="ghost-next-num mono">{step.num}</span>
          <span className="ghost-next-title">{step.title}</span>
        </span>
      ))}
    </p>
  </div>
);

export { GhostSteps };
