// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { LogDialog } from "../../../src/webapp/components/log-dialog.tsx";

describe("LogDialog", () => {
  it("renders the page logs dialog shell with an accessible name", () => {
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={() => undefined} open={false} />
      </RomWeaverSettingsProvider>,
    );

    const dialog = container.querySelector<HTMLDialogElement>("dialog.log-dlg");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).toBe("log-title");
    expect(container.querySelector("#log-title")?.textContent).toBe("Page Logs");
    expect(container.querySelector(".tracelog")).not.toBeNull();
  });

  it("defaults the capture level to warn and reports level changes", () => {
    const onLevelChange = vi.fn();
    const { container } = render(
      <RomWeaverSettingsProvider settings={{}}>
        <LogDialog onClose={() => undefined} onLevelChange={onLevelChange} open={false} />
      </RomWeaverSettingsProvider>,
    );

    const select = container.querySelector<HTMLSelectElement>(".loglevel select");
    expect(select?.value).toBe("warn");

    if (!select) throw new Error("log-level select not found");
    select.value = "trace";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onLevelChange).toHaveBeenCalledWith("trace");
  });
});
