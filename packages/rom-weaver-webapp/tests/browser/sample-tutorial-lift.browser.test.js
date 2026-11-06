import { afterEach, expect, test } from "vitest";
import "../../src/webapp/design-system/index.css";
import "../../src/webapp/design-system/deferred.css";

let host;

afterEach(() => host?.remove());

// The Create tour's Modified step lifts the swap row it overlaps: the button
// straddles the Modified header by design, so both sit on the lift/target
// layers and the lift has to win the hit test.
test("the lifted swap button stays clickable above the Modified step in the tour", () => {
  host = document.createElement("div");
  host.className = "rw-app";
  host.style.width = "720px";
  host.innerHTML = `
    <section class="panel workflow">
      <div class="step" id="patch-builder-row-original"><div class="step-head"><span>Original</span></div></div>
      <div class="swap-row sample-tutorial-lift">
        <button class="btn swap-btn" id="patch-builder-button-swap-sources" type="button">Swap</button>
      </div>
      <div class="step sample-tutorial-target sample-tutorial-stage" id="patch-builder-row-modified">
        <div class="step-head"><span>Modified</span></div>
      </div>
    </section>`;
  document.body.append(host);

  const swap = document.getElementById("patch-builder-button-swap-sources");
  const rect = swap.getBoundingClientRect();
  // The row's -15px bottom margin tucks the button's lower half under Modified.
  for (const y of [rect.top + rect.height / 2, rect.bottom - 3]) {
    const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
    expect(swap.contains(hit)).toBe(true);
  }
});
