// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

describe("SettingsPanel sections", () => {
  it("groups Bundle and both post-apply settings under Webapp", () => {
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
    const postApplyDownloadGroup = container
      .querySelector("#settings-post-apply-download-behavior")
      ?.closest(".setgroup");
    const postApplyTestGroup = container.querySelector("#settings-post-apply-test-behavior")?.closest(".setgroup");

    expect(bundleGroup?.querySelector(".gtitle")?.textContent).toBe("Webapp");
    expect(postApplyDownloadGroup).toBe(bundleGroup);
    expect(postApplyTestGroup).toBe(bundleGroup);
    expect(container.querySelector("#settings-apply-play-button-enabled")).toBeNull();
  });
});
