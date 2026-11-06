// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowErrorMessage } from "../../../src/public/react/workflow-error-message.tsx";
import { Notice } from "../../../src/public/react/components/ds/feedback.tsx";

const storage = vi.hoisted(() => ({ listKeptRoms: vi.fn() }));
vi.mock("../../../src/storage/browser/kept-roms.ts", () => storage);

afterEach(cleanup);

beforeEach(() => {
  storage.listKeptRoms.mockResolvedValue([{ gameId: "a".repeat(40), size: 1024, status: "ready" }]);
});

it("shows kept usage, opens Storage, and offers a real retry after deletion", async () => {
  const retry = vi.fn();
  const open = vi.fn();
  window.addEventListener("rom-weaver-open-storage", open);
  try {
    render(<WorkflowErrorMessage message="STORAGE_FULL: Free up storage and try again." onRetry={retry} />);
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

const openStorageButton = () => screen.queryByRole("button", { name: "Open Saves & storage" });

it("decides by the displayed code, so engine storage-full needs no space text and other codes get none", async () => {
  const view = render(<WorkflowErrorMessage message="STORAGE_FULL: Couldn't save the result." />);
  expect(await screen.findByRole("button", { name: "Open Saves & storage" })).toBeTruthy();
  for (const message of [
    "OUTPUT_WRITE_FAILED: Destination file is not writable. Details: no space left",
    "COMPRESSION_FAILED: Extract failed. Details: QuotaExceededError",
  ]) {
    view.rerender(<WorkflowErrorMessage message={message} />);
    await waitFor(() => expect(openStorageButton()).toBeNull());
  }
  view.rerender(<WorkflowErrorMessage code="STORAGE_FULL" message="Couldn't save the result." />);
  expect(await screen.findByRole("button", { name: "Open Saves & storage" })).toBeTruthy();
  view.rerender(<WorkflowErrorMessage code="WORKER_FAILED" message="STORAGE_FULL: quota" />);
  await waitFor(() => expect(openStorageButton()).toBeNull());
});

it("routes a coded notice by its code prefix", async () => {
  const view = render(<Notice level="error">STORAGE_FULL: Couldn't save the result.</Notice>);
  expect(await screen.findByRole("button", { name: "Open Saves & storage" })).toBeTruthy();
  view.rerender(<Notice level="error">WORKER_FAILED: no space left</Notice>);
  await waitFor(() => expect(openStorageButton()).toBeNull());
});

it("also covers plain workflow notices and excludes ordinary write errors", async () => {
  const view = render(<Notice level="error">QuotaExceededError: full</Notice>);
  expect(await screen.findByRole("button", { name: "Open Saves & storage" })).toBeTruthy();
  view.rerender(<Notice level="error">Permission denied</Notice>);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Open Saves & storage" })).toBeNull());
});
