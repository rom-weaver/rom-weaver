// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { DropRouteDialog } from "../../src/webapp/components/drop-route-dialog.tsx";
import type { WebappView } from "../../src/webapp/webapp-state-types.ts";

const files = (...names: string[]) => names.map((name) => new File(["x"], name));

const renderDialog = (from: WebappView, dropped: File[]) => {
  const delivered: { files: string[]; view: WebappView }[] = [];
  render(
    <RomWeaverSettingsProvider settings={{ language: "en" }}>
      <DropRouteDialog
        labelFor={(view) => (view === "trim" ? "Trim ROM" : view)}
        onCancel={() => undefined}
        onDeliver={(view, chosen) => delivered.push({ files: chosen.map((file) => file.name), view })}
        request={{ files: dropped, from, id: 1 }}
      />
    </RomWeaverSettingsProvider>,
  );
  return delivered;
};

describe("DropRouteDialog", () => {
  it("delivers every file when the picked page can use them all", () => {
    const delivered = renderDialog("home", files("game.sfc"));
    expect(screen.getByText("What do you want to do with this ROM?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Test ROM/ }));
    expect(delivered).toEqual([{ files: ["game.sfc"], view: "test" }]);
  });

  it("names the destination page, not the row, after choosing to stay", () => {
    const delivered = renderDialog("creator", files("game.sfc", "hack.ips"));
    fireEvent.click(screen.getByRole("button", { name: /Stay on Create Patch/ }));
    const submit = screen.getByRole("button", { name: "Open 1 file in Create Patch" });
    expect(screen.queryByText(/Open .* in Stay on/)).toBeNull();
    fireEvent.click(submit);
    expect(delivered).toEqual([{ files: ["game.sfc"], view: "creator" }]);
  });

  it("re-checks the files a page uses when the visitor switches page", () => {
    const delivered = renderDialog("home", files("original.sfc", "my-hack.sfc", "fix.ips"));
    fireEvent.click(screen.getByRole("button", { name: "Apply Patches" }));
    fireEvent.click(screen.getByRole("button", { name: "Open 3 files in Apply Patches" }));
    expect(delivered).toEqual([{ files: ["original.sfc", "my-hack.sfc", "fix.ips"], view: "patcher" }]);
  });

  it("lets the visitor bring files the page would not use", () => {
    const delivered = renderDialog("home", files("original.sfc", "my-hack.sfc", "fix.ips"));
    // Page and files are one choice: Create is picked first and only its ROMs start checked.
    expect(screen.getByRole("button", { name: "Create Patch", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open 2 files in Create Patch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Open 3 files in Create Patch" }));
    expect(delivered).toEqual([{ files: ["original.sfc", "my-hack.sfc", "fix.ips"], view: "creator" }]);
  });
});
