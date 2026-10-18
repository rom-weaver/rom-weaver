// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PatcherPrimaryAction } from "../../src/public/react/components/patcher-output-controls.tsx";
import { createEmptyPatcherOutputState } from "../../src/public/react/patcher-presentation.ts";
import { isApplyButtonActionable } from "../../src/public/react/patcher-view-models.ts";

/**
 * The WebMCP workflow state and the DOM controls list must agree on whether
 * Apply can run: a validation-blocked button is aria-disabled, so the state
 * reported to agents has to say "not enabled" too.
 */

const controllerFor = (applyButton: { blocked: boolean; disabled: boolean }) => {
  const state = createEmptyPatcherOutputState();
  state.applyButton = { ...state.applyButton, ...applyButton, loading: false };
  return {
    state,
    controller: {
      cancelPrimaryAction: () => undefined,
      getState: () => state,
      runPrimaryAction: () => undefined,
      setDisplayFileName: () => undefined,
      setOutputCompression: () => undefined,
      subscribe: () => () => undefined,
    },
  };
};

// Mirrors the `enabled` rule in src/webapp/agent/workflow-controls.ts.
const domEnabled = (element: Element) =>
  !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";

describe("apply action state agreement", () => {
  it.each([
    { blocked: false, disabled: false, enabled: true },
    { blocked: true, disabled: false, enabled: false },
    { blocked: false, disabled: true, enabled: false },
    { blocked: true, disabled: true, enabled: false },
  ])("blocked=$blocked disabled=$disabled matches the DOM button", ({ blocked, disabled, enabled }) => {
    const { controller, state } = controllerFor({ blocked, disabled });
    const { container } = render(<PatcherPrimaryAction controller={controller} />);
    const button = container.querySelector("#rom-weaver-button-apply") as HTMLButtonElement;
    expect(isApplyButtonActionable(state.applyButton)).toBe(enabled);
    expect(domEnabled(button)).toBe(enabled);
  });
});
