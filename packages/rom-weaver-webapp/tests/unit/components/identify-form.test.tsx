// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IdentifyForm } from "../../../src/webapp/components/identify-form.tsx";

const identifyRom = vi.fn(() => new Promise(() => undefined));

vi.mock("../../../src/platform/browser/browser-api.ts", () => ({ identifyRom }));

describe("IdentifyForm", () => {
  it("keeps the Files header and live identify timing while loading", async () => {
    const { container, unmount } = render(<IdentifyForm />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], "game.gba")] } });

    await waitFor(() => expect(container.querySelector("#rom-weaver-progress-identify-rom")).toBeTruthy());
    expect(container.querySelector(".card.file .extract-d .lab")?.textContent).toBe("Files");
    expect(container.querySelector(".card.file .extract-d .rb.time")?.textContent).toContain("Identify");
    unmount();
  });
});
