// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { getDefaultSettings, getSettingsUiState } from "../../src/webapp/settings/settings-state.ts";
import { SettingsPanel } from "../../src/webapp/webapp-settings.tsx";
import { createEmptyValidationState } from "../../src/webapp/webapp-state-types.ts";

const group = (overrides: Record<string, unknown> = {}) => ({
  id: "optional-computers",
  installed: false,
  label: "Computers and DOS",
  packs: 25,
  sizeBytes: 7_600_000,
  wanted: false,
  ...overrides,
});

const installIdentifyPackGroup = vi.fn(async () => undefined);
const setIdentifyPackGroupWanted = vi.fn(async () => [group({ installed: false, wanted: false })]);
const getIdentifyPackGroupState = vi.fn(async () => [group()]);

vi.mock("../../src/platform/browser/identify-packs.ts", () => ({
  getIdentifyPackGroupState: () => getIdentifyPackGroupState(),
  installIdentifyPackGroup,
  setIdentifyPackGroupWanted: (id: string, wanted: boolean) => setIdentifyPackGroupWanted(id, wanted),
}));

const renderSettings = () => {
  const draftSettings = getDefaultSettings();
  return render(
    <RomWeaverSettingsProvider settings={draftSettings}>
      <SettingsPanel
        draftSettings={draftSettings}
        onDraftChange={() => undefined}
        uiState={getSettingsUiState(draftSettings)}
        validation={createEmptyValidationState()}
      />
    </RomWeaverSettingsProvider>,
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("optional identify pack settings", () => {
  it("leaves optional databases unticked and shows what each one costs", async () => {
    getIdentifyPackGroupState.mockResolvedValue([group()]);
    const { findByRole, findByText } = renderSettings();

    const checkbox = (await findByRole("checkbox", { name: /Computers and DOS/ })) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(await findByText("7.6 MB")).toBeTruthy();
  });

  it("downloads the group when it is ticked", async () => {
    getIdentifyPackGroupState
      .mockResolvedValueOnce([group()])
      .mockResolvedValueOnce([group({ installed: true, wanted: true })]);
    const { findByRole } = renderSettings();

    fireEvent.click(await findByRole("checkbox", { name: /Computers and DOS/ }));

    await waitFor(() => expect(installIdentifyPackGroup).toHaveBeenCalledWith("optional-computers"));
    await waitFor(async () =>
      expect(((await findByRole("checkbox", { name: /Computers and DOS/ })) as HTMLInputElement).checked).toBe(true),
    );
  });

  it("removes the cached group when it is unticked", async () => {
    getIdentifyPackGroupState.mockResolvedValue([group({ installed: true, wanted: true })]);
    const { findByRole } = renderSettings();

    await waitFor(async () =>
      expect(((await findByRole("checkbox", { name: /Computers and DOS/ })) as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(await findByRole("checkbox", { name: /Computers and DOS/ }));

    await waitFor(() => expect(setIdentifyPackGroupWanted).toHaveBeenCalledWith("optional-computers", false));
    expect(installIdentifyPackGroup).not.toHaveBeenCalled();
  });
});
