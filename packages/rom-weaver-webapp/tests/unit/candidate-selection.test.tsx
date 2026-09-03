// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CandidateSelectionDialog, useCandidateSelection } from "../../src/public/react/candidate-selection.tsx";
import type { CandidateSelectionPrompt } from "../../src/public/react/public-types.ts";

const singleRequest = (overrides: Partial<CandidateSelectionPrompt> = {}): CandidateSelectionPrompt => ({
  sourceName: "patches.zip",
  role: "patch",
  warnings: ["Archive contains more than one supported entry"],
  candidates: [
    {
      type: "file",
      id: "patch-a",
      fileName: "folder/update.ips",
      kind: "patch",
      breadcrumbs: ["patches.zip", "folder"],
      reason: "Preferred patch",
      selectable: true,
      size: 1024,
      defaultSelected: true,
    },
    {
      type: "file",
      id: "patch-b",
      fileName: "other.bps",
      kind: "patch",
      breadcrumbs: ["patches.zip"],
      selectable: false,
      size: 20,
    },
  ],
  ...overrides,
});

describe("CandidateSelectionDialog", () => {
  it("renders archive context and resolves a selectable candidate", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    render(
      <CandidateSelectionDialog
        onCancel={onCancel}
        onSelect={onSelect}
        onSelectMany={vi.fn()}
        state={{
          request: singleRequest(),
          resolve: vi.fn(),
          reject: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole("dialog").textContent).toContain("patches.zip");
    expect(screen.getByText("folder › folder/update.ips")).toBeTruthy();
    expect(screen.getByText("matches patch")).toBeTruthy();
    expect(screen.getByText("1.02 KB")).toBeTruthy();
    expect(screen.queryByText("No selectable files in this source")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /folder\/update\.ips/ }));
    expect(onSelect).toHaveBeenCalledWith("patch-a");
  });

  it("uses the multi-select picker, preserves order, and supports select all", () => {
    const onSelectMany = vi.fn();
    render(
      <CandidateSelectionDialog
        onCancel={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={onSelectMany}
        state={{
          request: singleRequest({
            candidates: [
              ...singleRequest().candidates.slice(0, 1),
              {
                type: "file",
                id: "patch-c",
                fileName: "second.ups",
                kind: "patch",
                selectable: true,
              },
            ],
            multiSelect: true,
          }),
          resolve: vi.fn(),
          reject: vi.fn(),
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Add 1 patch" })).toBeTruthy();
    const checkboxes = screen.getAllByRole("checkbox");
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Add 2 patches" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 patches" }));
    expect(onSelectMany).toHaveBeenCalledWith(["patch-a", "patch-c"]);
  });

  it("shows a no-selectable state and forwards modal cancellation", () => {
    const onCancel = vi.fn();
    render(
      <CandidateSelectionDialog
        onCancel={onCancel}
        onSelect={vi.fn()}
        onSelectMany={vi.fn()}
        state={{
          request: singleRequest({
            candidates: singleRequest().candidates.map((candidate) => ({ ...candidate, selectable: false })),
          }),
          resolve: vi.fn(),
          reject: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("No selectable files in this source")).toBeTruthy();
    fireEvent.click(document.querySelector(".dlg-x") as HTMLButtonElement);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("useCandidateSelection", () => {
  it("resolves one request, queues the next, and reports cancellation", async () => {
    const onCancelSelection = vi.fn();
    const { result } = renderHook(() => useCandidateSelection({ onCancelSelection }));
    const first = singleRequest();
    const second = singleRequest({ sourceName: "other.zip" });
    let firstChoice: Promise<unknown> | undefined;
    let secondChoice: Promise<unknown> | undefined;

    act(() => {
      firstChoice = result.current.selectFile(first);
      secondChoice = result.current.selectFile(second);
    });
    await waitFor(() => expect(result.current.candidateSelectionDialog.props.state).not.toBeNull());
    const firstView = render(result.current.candidateSelectionDialog);
    fireEvent.click(firstView.getByRole("button", { name: /folder\/update\.ips/ }));
    await expect(firstChoice).resolves.toEqual({ id: "patch-a" });

    await waitFor(() =>
      expect(result.current.candidateSelectionDialog.props.state?.request.sourceName).toBe("other.zip"),
    );
    firstView.rerender(result.current.candidateSelectionDialog);
    fireEvent.click(firstView.getByRole("button", { name: /folder\/update\.ips/ }));
    await expect(secondChoice).resolves.toEqual({ id: "patch-a" });

    let cancelled: Promise<unknown> | undefined;
    act(() => {
      cancelled = result.current.selectFile(first);
    });
    await waitFor(() => expect(result.current.candidateSelectionDialog.props.state).not.toBeNull());
    act(() => result.current.cancelSelection());
    await expect(cancelled).rejects.toMatchObject({
      code: "WORKFLOW_SELECTION_SKIPPED",
      message: "Selection skipped",
    });
    expect(onCancelSelection).toHaveBeenCalledWith(first);
  });
});
