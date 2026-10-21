/**
 * The workflow panel head is drawn over the first step's heading row, so its
 * labels can land on that step's title. Whether they do depends on the locale,
 * the workflow, the Detailed state, and the thread count together - too many
 * combinations for fixed breakpoints - so the head measures the room beside
 * the title and sheds labels one at a time until it fits: Reset's, then the
 * view switch's, then the word after the thread count.
 */

/** Gap kept between the title's last mark and the first heading control. */
const TITLE_CLEARANCE_PX = 8;
const MAX_FIT_LEVEL = 3;

/** Right edge of the first step's number, title text, and the info mark after it. */
const readTitleEnd = (panel: HTMLElement, head: HTMLElement): number | null => {
  const stepHead = panel.querySelector<HTMLElement>(".workflow-body .step > .step-head");
  const title = stepHead?.querySelector<HTMLElement>(":scope > .step-title");
  if (!(stepHead && title)) return null;
  const headRect = head.getBoundingClientRect();
  // The title can be a block wider than its words; only the words can collide.
  const range = document.createRange();
  range.selectNodeContents(title);
  const marks = [range.getBoundingClientRect()];
  const next = title.nextElementSibling;
  if (next && !next.matches(".step-meta, .step-collapse, .step-head-action")) marks.push(next.getBoundingClientRect());
  let end: number | null = null;
  for (const rect of marks) {
    if (!rect.width || rect.bottom <= headRect.top || rect.top >= headRect.bottom) continue;
    end = Math.max(end ?? rect.right, rect.right);
  }
  return end;
};

/** Step heads whose title this head has shortened, so a refit can restore them. */
const crowdedStepHeads = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Sets `data-fit` on the head to the fewest shed labels that clear the title.
 * When even the bare controls do not fit, the title gives way instead: it is
 * shortened with an ellipsis rather than drawn under the controls. A hidden
 * panel has nothing to measure and keeps its last state.
 */
const fitPanelHead = (panel: HTMLElement, head: HTMLElement) => {
  if (readTitleEnd(panel, head) === null) return;
  const crowded = crowdedStepHeads.get(head);
  if (crowded) {
    delete crowded.dataset.headCrowded;
    crowded.style.removeProperty("--panel-head-room");
    crowdedStepHeads.delete(head);
  }
  let level = 0;
  head.dataset.fit = "0";
  let titleEnd = readTitleEnd(panel, head) ?? 0;
  while (level < MAX_FIT_LEVEL && head.getBoundingClientRect().left < titleEnd + TITLE_CLEARANCE_PX) {
    level += 1;
    head.dataset.fit = String(level);
    titleEnd = readTitleEnd(panel, head) ?? titleEnd;
  }
  const headRect = head.getBoundingClientRect();
  const stepHead = panel.querySelector<HTMLElement>(".workflow-body .step > .step-head");
  if (!stepHead || headRect.left >= titleEnd + TITLE_CLEARANCE_PX) return;
  const room = stepHead.getBoundingClientRect().right - headRect.left + TITLE_CLEARANCE_PX;
  stepHead.style.setProperty("--panel-head-room", `${Math.ceil(room)}px`);
  stepHead.dataset.headCrowded = "";
  crowdedStepHeads.set(head, stepHead);
};

/**
 * Refits whenever the panel, the head, or the mounted form changes size.
 * Without ResizeObserver the media-query floor in workbench.css stands alone.
 */
const observePanelHeadFit = (head: HTMLElement): (() => void) | undefined => {
  const panel = head.closest<HTMLElement>(".panel");
  if (!panel || typeof ResizeObserver === "undefined") return undefined;
  let frame = 0;
  const run = () => {
    frame = 0;
    fitPanelHead(panel, head);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(panel);
  observer.observe(head);
  const body = panel.querySelector(".workflow-body");
  if (body) observer.observe(body);
  // Web fonts swap in after first layout and change both rows' widths.
  void document.fonts?.ready.then(schedule);
  run();
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
};

export { observePanelHeadFit };
