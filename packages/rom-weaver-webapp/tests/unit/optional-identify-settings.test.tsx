// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

const installIdentifyPackGroup = vi.fn(async () => undefined);

vi.mock("../../src/platform/browser/identify-packs.ts", () => ({
  installIdentifyPackGroup,
  listOptionalIdentifyPackGroups: async () => [
    {
      default: false,
      id: "optional-computers",
      label: "Computers and DOS",
      systems: ["microsoft-ms-dos"],
    },
  ],
}));

describe("optional identify pack settings", () => {
  it("installs the computer pack group from Settings", async () => {
    const draftSettings = getDefaultSettings();
    const { findByRole } = render(
      <RomWeaverSettingsProvider settings={draftSettings}>
        <SettingsPanel
          draftSettings={draftSettings}
          onDraftChange={() => undefined}
          uiState={getSettingsUiState(draftSettings)}
          validation={createEmptyValidationState()}
        />
      </RomWeaverSettingsProvider>,
    );

    fireEvent.click(await findByRole("button", { name: "Install" }));

    await waitFor(() => expect(installIdentifyPackGroup).toHaveBeenCalledWith("optional-computers"));
    expect(((await findByRole("button", { name: "Installed" })) as HTMLButtonElement).disabled).toBe(true);
  });
});
