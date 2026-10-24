// @vitest-environment happy-dom
import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { applyAccent, useAccent } from "../../src/webapp/accent.ts";
import { DEFAULT_CHANNEL_ACCENT } from "../../src/webapp/build-channel.ts";

it("hydrates the saved accent label from the channel shell without stale attributes", async () => {
  const Label = () => <button aria-label={`Accent: ${useAccent()}`} type="button" />;
  applyAccent(DEFAULT_CHANNEL_ACCENT);
  const container = document.createElement("div");
  container.innerHTML = renderToString(<Label />);
  document.body.append(container);
  applyAccent(DEFAULT_CHANNEL_ACCENT === "woad" ? "violet" : "woad");
  const recover = vi.fn();
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(container, <Label />, { onRecoverableError: recover });
  });
  expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
    `Accent: ${DEFAULT_CHANNEL_ACCENT === "woad" ? "violet" : "woad"}`,
  );
  expect(recover).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  container.remove();
  applyAccent(DEFAULT_CHANNEL_ACCENT);
});
