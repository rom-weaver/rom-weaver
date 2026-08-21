// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

describe("SettingsPanel sections", () => {
  it("separates Webapp presentation and Behavior workflow settings", () => {
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
    const groupFor = (id: string) => container.querySelector(id)?.closest(".setgroup");
    const webappGroup = groupFor("#settings-theme");
    const behaviorGroup = groupFor("#settings-bundle-package");

    expect(webappGroup?.querySelector(".gtitle")?.textContent).toBe("Webapp");
    for (const id of [
      "#settings-language",
      "#settings-accent",
      "#settings-byte-units",
      "#settings-log-level",
      "#settings-onboarding-enabled",
      "#settings-beta-tools-enabled",
    ])
      expect(groupFor(id)).toBe(webappGroup);

    expect(behaviorGroup?.querySelector(".gtitle")?.textContent).toBe("Behavior");
    for (const id of [
      "#settings-post-apply-download-behavior",
      "#settings-post-apply-test-behavior",
      "#settings-emulator-save-storage-enabled",
      "#settings-fix-checksum",
      "#settings-require-input-checksum-match",
    ])
      expect(groupFor(id)).toBe(behaviorGroup);

    expect(webappGroup).not.toBe(behaviorGroup);
    expect(container.querySelector("#settings-apply-play-button-enabled")).toBeNull();
  });
});
