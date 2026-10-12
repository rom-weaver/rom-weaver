// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { preloadCatalog } from "../../src/presentation/localization/index.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { setAdvancedSettings } from "../../src/webapp/advanced-settings.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

describe("SettingsPanel sections", () => {
  it("hides threads and codec settings until Advanced is on", () => {
    setAdvancedSettings(false);
    const draftSettings = getDefaultSettings();
    const { container, getByRole } = render(
      <RomWeaverSettingsProvider settings={draftSettings}>
        <SettingsPanel
          draftSettings={draftSettings}
          onDraftChange={() => undefined}
          uiState={getSettingsUiState(draftSettings)}
          validation={createEmptyValidationState()}
        />
      </RomWeaverSettingsProvider>,
    );
    const titles = () => Array.from(container.querySelectorAll(".setgroup .gtitle"), (title) => title.textContent);

    expect(container.querySelector("#settings-worker-threads")).toBeNull();
    expect(titles()).not.toContain("Codecs");
    expect(container.querySelector("#settings-group-compression")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Show advanced" }));
    expect(container.querySelector("#settings-worker-threads")).not.toBeNull();
    expect(titles()).toContain("Codecs");
    expect(container.querySelector(".console-hidden-note")).toBeNull();
    setAdvancedSettings(false);
  });

  it("starts with the offline-copy choice enabled and stages changes", () => {
    const draftSettings = getDefaultSettings();
    const onDraftChange = vi.fn();
    const { getByRole } = render(
      <RomWeaverSettingsProvider settings={draftSettings}>
        <SettingsPanel
          draftSettings={draftSettings}
          onDraftChange={onDraftChange}
          uiState={getSettingsUiState(draftSettings)}
          validation={createEmptyValidationState()}
        />
      </RomWeaverSettingsProvider>,
    );
    const checkbox = getByRole("checkbox", { name: "Keep an offline copy" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(onDraftChange).toHaveBeenCalledWith("offlineCopyEnabled", false);
  });

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
    const behaviorGroup = groupFor("#settings-weave-package");

    expect(webappGroup?.querySelector(".gtitle")?.textContent).toBe("Webapp");
    for (const id of [
      "#settings-language",
      "#settings-accent",
      "#settings-byte-units",
      "#settings-log-level",
      "#settings-offline-copy-enabled",
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

describe("SettingsPanel localization", () => {
  it("renders group titles, option labels, and details in German", async () => {
    await preloadCatalog("de");
    setAdvancedSettings(true);
    const draftSettings = { ...getDefaultSettings(), language: "de" };
    const { container, getAllByRole } = render(
      <RomWeaverSettingsProvider settings={draftSettings}>
        <SettingsPanel
          draftSettings={draftSettings}
          onDraftChange={() => undefined}
          uiState={getSettingsUiState(draftSettings)}
          validation={createEmptyValidationState()}
        />
      </RomWeaverSettingsProvider>,
    );
    const titles = Array.from(container.querySelectorAll(".setgroup .gtitle"), (title) => title.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Web-App", "Verhalten", "Komprimierung"]));
    // Group anchors keep their stable English ids in every locale.
    expect(container.querySelector("#settings-group-compression")).not.toBeNull();
    const logLevel = container.querySelector("#settings-log-level") as HTMLSelectElement;
    expect(Array.from(logLevel.options, (option) => option.textContent)).toContain("Fehler");
    const byteUnits = container.querySelector("#settings-byte-units") as HTMLSelectElement;
    expect(byteUnits.options[0]?.textContent).toBe("Dezimal (KB, MB, GB) (Standard)");
    expect(getAllByRole("button", { name: /Details zu .* anzeigen/ }).length).toBeGreaterThan(0);
    setAdvancedSettings(false);
  });
});
