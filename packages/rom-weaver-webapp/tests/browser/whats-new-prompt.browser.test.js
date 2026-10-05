import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { APP_BUILD_VERSION } from "../../src/webapp/build-version.ts";
import { useWhatsNewPrompt } from "../../src/webapp/use-whats-new-prompt.ts";

const key = `rom-weaver-whats-new:${APP_BUILD_VERSION}`;
const Probe = ({ opened = false }) => createElement("span", null, useWhatsNewPrompt(opened) ? "visible" : "hidden");
beforeEach(() => {
  localStorage.removeItem(key);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.removeItem(key);
});
test("expires two hours after first seeing the build, including across remounts", async () => {
  const first = render(createElement(Probe));
  expect(screen.getByText("visible")).toBeTruthy();
  await act(() => vi.advanceTimersByTime(60 * 60 * 1000));
  first.unmount();
  render(createElement(Probe));
  expect(screen.getByText("visible")).toBeTruthy();
  await act(() => vi.advanceTimersByTime(60 * 60 * 1000));
  expect(screen.getByText("hidden")).toBeTruthy();
});
test("opening the changelog dismisses the prompt across remounts", () => {
  const view = render(createElement(Probe));
  view.rerender(createElement(Probe, { opened: true }));
  expect(screen.getByText("hidden")).toBeTruthy();
  view.unmount();
  render(createElement(Probe));
  expect(screen.getByText("hidden")).toBeTruthy();
});
test("a different build gets a new prompt", () => {
  localStorage.setItem(key, JSON.stringify({ build: "old-build", firstSeen: 0, used: true }));
  render(createElement(Probe));
  expect(screen.getByText("visible")).toBeTruthy();
});
test("corrupt stored state gets a fresh prompt", () => {
  localStorage.setItem(key, "invalid");
  render(createElement(Probe));
  expect(screen.getByText("visible")).toBeTruthy();
});

test("other builds cannot reset this build's dismissal", async () => {
  const view = render(createElement(Probe, { opened: true }));
  const dismissed = localStorage.getItem(key);
  await act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "rom-weaver-whats-new:other-build",
        newValue: JSON.stringify({ build: "other-build", firstSeen: Date.now(), used: false }),
      }),
    ),
  );
  expect(localStorage.getItem(key)).toBe(dismissed);
  view.rerender(createElement(Probe));
  expect(screen.getByText("hidden")).toBeTruthy();
});
