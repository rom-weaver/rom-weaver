// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";

// The suite runs without vitest globals, so RTL cannot auto-clean between tests.
afterEach(cleanup);

describe("LogDialog", () => {
  it("wears the weft sub-rail as its header, opening on the tab it was asked for", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={() => undefined} open={false} />
      </RomWeaverSettingsProvider>,
    );

    const dialog = container.querySelector<HTMLDialogElement>("dialog.log-dlg");
    expect(dialog).not.toBeNull();
    // the tabs are the header - there is no title competing with them
    expect(container.querySelector(".dlg-title")).toBeNull();
    const tabs = Array.from(container.querySelectorAll('.dialog-subrail [role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Status", "Logs", "Storage", "Changelog"]);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length).toBe(1);
    expect(container.querySelector("#logpanel-status")).not.toBeNull();
    expect(container.querySelector(".status-rows")).not.toBeNull();
    // the trace log belongs to the Logs tab, so it is not mounted on Status
    expect(container.querySelector(".tracelog")).toBeNull();
  });

  it("defaults the capture level to warn and reports level changes", () => {
    const onLevelChange = vi.fn();
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog initialTab="logs" onClose={() => undefined} onLevelChange={onLevelChange} open={false} />
      </RomWeaverSettingsProvider>,
    );

    expect(container.querySelector(".tracelog")).not.toBeNull();
    const select = container.querySelector<HTMLSelectElement>(".loglevel select");
    expect(select?.value).toBe("warn");

    if (!select) throw new Error("log-level select not found");
    select.value = "trace";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onLevelChange).toHaveBeenCalledWith("trace");
  });
});
