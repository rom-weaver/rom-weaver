// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { LoadErrorBoundary } from "../../../src/webapp/components/load-error-boundary.tsx";

// A route chunk that a deploy removed from the host.
const MissingChunk = lazy(() =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/whats-new-page-old.js")),
);

const renderPanels = (fullPage = false) => {
  const onReload = vi.fn();
  const view = render(
    <RomWeaverSettingsProvider settings={{}}>
      <section aria-label="Apply">
        <input aria-label="Staged ROM" defaultValue="game.sfc" />
      </section>
      <LoadErrorBoundary area="whats-new" fullPage={fullPage} onReload={onReload}>
        <Suspense fallback={null}>
          <MissingChunk />
        </Suspense>
      </LoadErrorBoundary>
    </RomWeaverSettingsProvider>,
  );
  return { ...view, onReload };
};

afterEach(() => vi.restoreAllMocks());

describe("LoadErrorBoundary", () => {
  it("replaces only its own part of the page when a chunk fails to load", async () => {
    // React reports the caught error to the console; the assertion is on what stays rendered.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, onReload } = renderPanels();

    const notice = await screen.findByRole("alert");

    expect(notice.textContent).toContain("This page didn’t load");
    expect(container.querySelector("main")).toBeNull();
    expect((screen.getByLabelText("Staged ROM") as HTMLInputElement).value).toBe("game.sfc");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("stands in for the whole app with the 404 page's centering", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderPanels(true);

    const notice = await screen.findByRole("alert");

    expect(notice.closest("main.workbench.is-not-found")).not.toBeNull();
  });

  it("renders its children while nothing fails", () => {
    render(
      <RomWeaverSettingsProvider settings={{}}>
        <LoadErrorBoundary area="home" onReload={() => undefined}>
          <p>Home</p>
        </LoadErrorBoundary>
      </RomWeaverSettingsProvider>,
    );

    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
