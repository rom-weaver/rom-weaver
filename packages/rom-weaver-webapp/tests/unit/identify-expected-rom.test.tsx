// @vitest-environment happy-dom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { lookupExpectedRom } from "../../src/lib/apply/expected-rom-lookup.ts";
import { IdentifyForm } from "../../src/webapp/components/identify-form.tsx";

// The checksum search and the file identify are the two seams the form runs on;
// stubbing both keeps this test on the expectation logic.
vi.mock("../../src/lib/apply/expected-rom-lookup.ts", () => ({ lookupExpectedRom: vi.fn() }));
const identifyRom = vi.fn();
vi.mock("../../src/platform/browser/browser-api.ts", () => ({
  identifyHash: vi.fn(),
  identifyRom: (...args: unknown[]) => identifyRom(...args),
}));

const mockedLookup = vi.mocked(lookupExpectedRom);

const MATCH = {
  algorithm: "crc32" as const,
  database: "No-Intro",
  name: "Metroid Fusion (USA)",
  platform: "Nintendo - Game Boy Advance",
  variant: "raw",
};

const stageCandidate = (crc32: string) => ({
  candidates: [{ checksumVariants: [], checksums: { crc32 }, matches: [MATCH], path: "game.gba", status: "matched" }],
  input: "game.gba",
  status: "matched",
});

beforeEach(() => {
  mockedLookup.mockReset();
  identifyRom.mockReset();
  mockedLookup.mockResolvedValue({ matches: [MATCH], status: "matched" });
});

const searchChecksum = async (container: HTMLElement, hash: string) => {
  const input = container.querySelector<HTMLInputElement>(".identify-hash-input");
  if (!input) throw new Error("the checksum search input is missing");
  fireEvent.change(input, { target: { value: hash } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  await waitFor(() => expect(container.querySelector("#identify-container-expected-rom")).not.toBeNull());
};

const stageRom = async (container: HTMLElement) => {
  const picker = container.querySelector<HTMLInputElement>("#identify-input-picker");
  if (!picker) throw new Error("the expected-ROM picker is missing");
  fireEvent.change(picker, { target: { files: [new File([new Uint8Array([1, 2, 3, 4])], "game.gba")] } });
  await waitFor(() => expect(container.querySelector(".card")).not.toBeNull());
};

it("offers the optional ROM drop zone beside a checksum match", async () => {
  const { container } = render(<IdentifyForm />);

  await searchChecksum(container, "abcd1234");

  expect(container.textContent).toContain("Metroid Fusion (USA)");
  // 0x01 owns every input, so the match turns its add row into the verify path.
  expect(container.textContent).toContain("Add the ROM to verify it");
  expect(container.textContent).toContain("Optional - the match above stands on its own");
  expect(container.querySelector(".ghost-steps")).toBeNull();
});

it("marks the staged ROM ok when it matches the pasted checksum", async () => {
  identifyRom.mockResolvedValue(stageCandidate("abcd1234"));
  const { container } = render(<IdentifyForm />);

  await searchChecksum(container, "abcd1234");
  await stageRom(container);

  await waitFor(() => expect(container.querySelector(".card.ok")).not.toBeNull());
  // The expectation survives the drop and lands as Expected rows on the card.
  expect(container.querySelector("#rom-weaver-rom-expected-checks")).not.toBeNull();
});

it("faults the step when the staged ROM misses the pasted checksum", async () => {
  identifyRom.mockResolvedValue(stageCandidate("deadbeef"));
  const { container } = render(<IdentifyForm />);

  await searchChecksum(container, "abcd1234");
  await stageRom(container);

  await waitFor(() => expect(container.querySelector(".card.bad")).not.toBeNull());
});

it("clearing the expectation clears the lookup", async () => {
  const { container } = render(<IdentifyForm />);

  await searchChecksum(container, "abcd1234");
  const remove = container.querySelector<HTMLButtonElement>(
    '#identify-container-expected-rom button[aria-label="Clear the expected ROM"]',
  );
  if (!remove) throw new Error("the expectation card has no remove button");
  fireEvent.click(remove);

  await waitFor(() => expect(container.querySelector("#identify-container-expected-rom")).toBeNull());
  expect(container.querySelector<HTMLInputElement>(".identify-hash-input")?.value).toBe("");
  expect(container.querySelector(".ghost-steps")).not.toBeNull();
});

it("typing in the search opens the ROM step and hides the hero", async () => {
  const { container } = render(<IdentifyForm />);
  expect(container.querySelector(".unified-drop-step--hero")).not.toBeNull();

  const input = container.querySelector<HTMLInputElement>(".identify-hash-input");
  if (!input) throw new Error("the checksum search input is missing");
  fireEvent.change(input, { target: { value: "abcd" } });

  await waitFor(() => expect(container.querySelector(".unified-drop-step--hero")).toBeNull());
  expect(container.querySelector(".ghost-steps")).toBeNull();
  expect(container.textContent).toContain("Add a ROM to identify it");
});
