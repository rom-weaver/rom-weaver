// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CandidateSelectionDialog, useCandidateSelection } from "../../src/public/react/candidate-selection.tsx";
import { useInputSelectionHandler } from "../../src/public/react/input-selection-handler.ts";
import { resolveInputSelection } from "../../src/workers/rom-weaver/runner-control.ts";
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
  it("uses file wording for a checksum input selection", () => {
    render(
      <CandidateSelectionDialog
        fileInput
        onCancel={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={vi.fn()}
        state={{ request: singleRequest({ role: "input" }), resolve: vi.fn(), reject: vi.fn() }}
      />,
    );
    expect(screen.getByText("Multiple candidates found, select one")).toBeTruthy();
    expect(screen.queryByText("Select the ROM to use")).toBeNull();
  });

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

  it("uses file wording without the patch match tag for a non-patch multi-select", () => {
    const onSelectMany = vi.fn();
    render(
      <CandidateSelectionDialog
        onCancel={vi.fn()}
        onSelect={vi.fn()}
        onSelectMany={onSelectMany}
        state={{
          request: {
            candidates: ["disc.cue", "track.bin"].map((fileName, index) => ({
              defaultSelected: true,
              fileName,
              id: String(index),
              kind: "rom" as const,
              selectable: true,
              type: "file" as const,
            })),
            multiSelect: true,
            role: "input",
            sourceName: "disc.zip",
            warnings: [],
          },
          resolve: vi.fn(),
          reject: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText("Select the files you want to add, then choose Add files.")).toBeTruthy();
    expect(screen.queryByText("matches patch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add 2 files" }));
    expect(onSelectMany).toHaveBeenCalledWith(["0", "1"]);
  });

  it("offers an off-by-default keep-source switch that replaces the picked entries", () => {
    const onKeepSource = vi.fn();
    const onSelectMany = vi.fn();
    render(
      <CandidateSelectionDialog
        onCancel={vi.fn()}
        onKeepSource={onKeepSource}
        onSelect={vi.fn()}
        onSelectMany={onSelectMany}
        state={{
          request: {
            candidates: [
              { defaultSelected: true, fileName: "game.sfc", id: "0", kind: "rom", selectable: true, type: "file" },
            ],
            keepSourceLabel: "Keep packed",
            multiSelect: true,
            role: "input",
            sourceName: "game.zip",
            warnings: [],
          },
          resolve: vi.fn(),
          reject: vi.fn(),
        }}
      />,
    );

    const keep = screen.getByRole("switch", { name: "Keep packed" }) as HTMLInputElement;
    const entry = screen.getByRole("checkbox") as HTMLInputElement;
    expect(keep.checked).toBe(false);
    expect(entry.disabled).toBe(false);
    fireEvent.click(keep);
    expect(entry.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add 1 file" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add archive" }));
    expect(onKeepSource).toHaveBeenCalledOnce();
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));
    expect(onSelectMany).toHaveBeenCalledWith(["0"]);
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
  it("rejects active and queued requests when their form unmounts", async () => {
    const onCancelSelection = vi.fn();
    const { result, unmount } = renderHook(() => useCandidateSelection({ onCancelSelection }));
    const settled = vi.fn();
    act(() => {
      void result.current.selectFile(singleRequest()).catch(settled);
      void result.current.selectFile(singleRequest({ sourceName: "queued.zip" })).catch(settled);
    });

    unmount();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledTimes(2);
    for (const [error] of settled.mock.calls) {
      expect(error).toMatchObject({ code: "WORKFLOW_SELECTION_SKIPPED" });
    }
    // Unmount is lifecycle cleanup, not another user cancellation event.
    expect(onCancelSelection).not.toHaveBeenCalled();
  });

  it("rejects a delayed request sent to an unmounted form", async () => {
    const { result, unmount } = renderHook(() => useCandidateSelection());
    const selectFile = result.current.selectFile;
    unmount();
    const settled = vi.fn();
    void selectFile(singleRequest()).catch(settled);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: "WORKFLOW_SELECTION_SKIPPED" }));
  });

  it("accepts requests after StrictMode replays the mount effect", async () => {
    const { result } = renderHook(() => useCandidateSelection(), { wrapper: StrictMode });
    let choice: Promise<unknown> | undefined;
    act(() => {
      choice = result.current.selectFile(singleRequest());
    });
    const view = render(result.current.candidateSelectionDialog);
    fireEvent.click(view.getByRole("button", { name: /folder\/update\.ips/ }));
    await expect(choice).resolves.toEqual({ id: "patch-a" });
  });

  it("releases the global host-prompt chain so a replacement form can select", async () => {
    const useFormSelection = () => {
      const selection = useCandidateSelection();
      useInputSelectionHandler("embedded", selection.selectFile);
      return selection;
    };
    const request = JSON.stringify({ candidates: [{ label: "game-a.bin" }, { label: "game-b.bin" }] });
    const old = renderHook(useFormSelection);
    const cancelled = vi.fn();
    void Promise.resolve(resolveInputSelection(request)).then(cancelled);
    await waitFor(() => expect(old.result.current.candidateSelectionDialog.props.state).not.toBeNull());
    old.unmount();
    await waitFor(() => expect(cancelled).toHaveBeenCalledWith([]));

    const replacement = renderHook(useFormSelection);
    const choice = Promise.resolve(resolveInputSelection(request));
    await waitFor(() => expect(replacement.result.current.candidateSelectionDialog.props.state).not.toBeNull());
    const view = render(replacement.result.current.candidateSelectionDialog);
    fireEvent.click(view.getByRole("button", { name: /game-b\.bin/ }));
    await expect(choice).resolves.toEqual([1]);
  });

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

  it("opens each queued keep-source request with the switch off", async () => {
    const request = (sourceName: string): CandidateSelectionPrompt => ({
      candidates: [
        { defaultSelected: true, fileName: "game.sfc", id: "0", kind: "rom", selectable: true, type: "file" },
      ],
      keepSourceLabel: "Keep packed",
      multiSelect: true,
      role: "input",
      sourceName,
      warnings: [],
    });
    const { result } = renderHook(() => useCandidateSelection());
    const view = render(result.current.candidateSelectionDialog);
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.selectFile(request("a.zip"));
      second = result.current.selectFile(request("b.zip"));
    });
    view.rerender(result.current.candidateSelectionDialog);
    fireEvent.click(screen.getByRole("switch", { name: "Keep packed" }));
    fireEvent.click(screen.getByRole("button", { name: "Add archive" }));
    await expect(first).resolves.toEqual({ id: "", ids: [], keepSource: true });

    view.rerender(result.current.candidateSelectionDialog);
    expect((screen.getByRole("switch", { name: "Keep packed" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 file" }));
    await expect(second).resolves.toEqual({ id: "0", ids: ["0"] });
  });
});
