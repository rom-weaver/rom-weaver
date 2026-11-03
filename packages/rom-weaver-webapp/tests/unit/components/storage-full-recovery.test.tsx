// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkflowErrorMessage } from "../../../src/public/react/workflow-error-message.tsx";
import { Notice } from "../../../src/public/react/components/ds/feedback.tsx";

const storage = vi.hoisted(() => ({ listKeptRoms: vi.fn() }));
vi.mock("../../../src/storage/browser/kept-roms.ts", () => storage);

beforeEach(() => {
  storage.listKeptRoms.mockResolvedValue([{ gameId: "a".repeat(40), size: 1024, status: "ready" }]);
});

it("shows kept usage, opens Storage, and offers a real retry after deletion", async () => {
  const retry = vi.fn();
  const open = vi.fn();
  window.addEventListener("rom-weaver-open-storage", open);
  try {
    render(<WorkflowErrorMessage message="OUTPUT_WRITE_FAILED: No space left on device" onRetry={retry} />);
    expect(await screen.findByText(/Kept Test ROMs use 1.02 KB/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Saves & storage" }));
    expect(open).toHaveBeenCalledOnce();
    storage.listKeptRoms.mockResolvedValue([]);
    await act(() => window.dispatchEvent(new Event("rom-weaver-kept-roms-changed")));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("rom-weaver-open-storage", open);
  }
});

it("also covers plain workflow notices and excludes ordinary write errors", async () => {
  const view = render(<Notice level="error">QuotaExceededError: full</Notice>);
  expect(await screen.findByRole("button", { name: "Open Saves & storage" })).toBeTruthy();
  view.rerender(<Notice level="error">Permission denied</Notice>);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open Saves & storage" })).toBeNull());
});
