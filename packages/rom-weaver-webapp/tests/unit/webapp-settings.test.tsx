// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

describe("SettingsPanel sections", () => {
  it("groups Bundle and After applying under Webapp", () => {
    const draftSettings = getDefaultSettings();
    const { container } = render(
      <RomWeaverSettingsProvider settings={draftSettings}>
        <SettingsPanel
          draftSettings={draftSettings}
          onDraftChange={() => undefined}
          uiState={getSettingsUiState(draftSettings)}
          validation={createEmptyValidationState()}
        />
      </RomWeaverSettingsProvider>,
    );
    const bundleGroup = container.querySelector("#settings-bundle-package")?.closest(".setgroup");
    const postApplyGroup = container.querySelector("#settings-post-apply-rom-behavior")?.closest(".setgroup");

    expect(bundleGroup?.querySelector(".gtitle")?.textContent).toBe("Webapp");
    expect(postApplyGroup).toBe(bundleGroup);
    expect(container.querySelector("#settings-apply-play-button-enabled")).toBeNull();
  });
});
