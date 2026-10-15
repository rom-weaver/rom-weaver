// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import type { DropEntry } from "../../src/public/react/drop-destination.ts";
import { DropRouteDialog } from "../../src/webapp/components/drop-route-dialog.tsx";
import type { WebappView } from "../../src/webapp/webapp-state-types.ts";

const files = (...names: string[]) => names.map((name) => new File(["x"], name));

const renderDialog = (from: WebappView, dropped: File[], entries?: DropEntry[]) => {
  const delivered: { files: string[]; view: WebappView }[] = [];
  render(
    <RomWeaverSettingsProvider settings={{ language: "en" }}>
      <DropRouteDialog
        labelFor={(view) => (view === "trim" ? "Trim ROM" : view)}
        onCancel={() => undefined}
        onDeliver={(view, chosen) => delivered.push({ files: chosen.map((file) => file.name), view })}
        request={{ entries, files: dropped, from, id: 1 }}
      />
    </RomWeaverSettingsProvider>,
  );
  return delivered;
};

describe("DropRouteDialog", () => {
  it.each([
    ["Apply Patches", "patcher"],
    ["Weave Patches", "weave"],
  ])("delivers a packaged weave to %s", (label, view) => {
    const delivered = renderDialog("home", files("release.zip"), [
      { name: "release.zip", archiveBucket: "patch", weave: true },
    ]);
    expect(screen.getByText("What do you want to do with this weave?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Test ROM/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
    expect(delivered).toEqual([{ files: ["release.zip"], view }]);
  });

  it("delivers every file when the picked page can use them all", () => {
    const delivered = renderDialog("home", files("game.sfc"));
    expect(screen.getByText("What do you want to do with this ROM?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Test ROM/ }));
    expect(delivered).toEqual([{ files: ["game.sfc"], view: "test" }]);
  });

  it("names the destination page, not the row, after choosing to stay", () => {
    const delivered = renderDialog("trim", files("game.sfc", "hack.ips"));
    fireEvent.click(screen.getByRole("button", { name: /Stay on Trim ROM/ }));
    const submit = screen.getByRole("button", { name: "Open 1 file in Trim ROM" });
    expect(screen.queryByText(/Open .* in Stay on/)).toBeNull();
    fireEvent.click(submit);
    expect(delivered).toEqual([{ files: ["game.sfc"], view: "trim" }]);
  });

  it("re-checks the files a page uses when the visitor switches page", () => {
    const delivered = renderDialog("test", files("game.sfc", "fix.ips", "game.sav"));
    expect(screen.getByRole("button", { name: "Open 2 files in Apply Patches" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stay on Test ROM/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open 2 files in Test ROM" }));
    expect(delivered).toEqual([{ files: ["game.sfc", "game.sav"], view: "test" }]);
  });

  it("delivers all ROM and patch files directly when Create can use the whole drop", () => {
    const delivered = renderDialog("home", files("original.sfc", "my-hack.sfc", "fix.ips"));
    fireEvent.click(screen.getByRole("button", { name: /^Create Patch / }));
    expect(delivered).toEqual([{ files: ["original.sfc", "my-hack.sfc", "fix.ips"], view: "creator" }]);
  });

  it("lets the visitor bring files the page would not use", () => {
    const delivered = renderDialog("home", files("original.sfc", "my-hack.sfc", "fix.ips", "game.sav"));
    expect(screen.getByRole("button", { name: "Create Patch", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open 3 files in Create Patch" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    fireEvent.click(screen.getByRole("button", { name: "Open 4 files in Create Patch" }));
    expect(delivered).toEqual([{ files: ["original.sfc", "my-hack.sfc", "fix.ips", "game.sav"], view: "creator" }]);
  });
});
