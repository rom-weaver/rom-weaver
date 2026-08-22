import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { SaveEditor } from "../../src/webapp/components/save-editor.tsx";
import "../../src/webapp/design-system/index.css";

const mocks = vi.hoisted(() => ({
  identifySave: vi.fn(),
  inspectSave: vi.fn(),
  listEmulatorSaves: vi.fn(),
  previewSaveFields: vi.fn(),
  replaceEmulatorSaveSram: vi.fn(),
  setSaveFields: vi.fn(),
}));

vi.mock("../../src/platform/browser/browser-save-api.ts", () => mocks);
vi.mock("../../src/storage/browser/emulator-saves.ts", () => ({
  listEmulatorSaves: mocks.listEmulatorSaves,
  replaceEmulatorSaveSram: mocks.replaceEmulatorSaveSram,
}));

let root;
let host;
let latestSaveAs;

const documentResult = () => ({
  document: {
    active_slot: 0,
    counter: 2,
    fields: [
      {
        constraints: { choices: [], max: null, max_length: 8, min: null },
        description: "Trainer name",
        editable: true,
        encoding: "ascii",
        id: "trainer.name",
        kind: "text",
        label: "Name",
        section_id: 0,
        step: null,
        value: { text: "ASH" },
        warnings: [],
      },
      {
        constraints: { choices: [], max: 999999, max_length: null, min: 0 },
        description: "Money",
        editable: true,
        encoding: null,
        id: "trainer.money",
        kind: "unsigned_integer",
        label: "Money",
        section_id: 0,
        step: 1,
        value: { u32: 5000 },
        warnings: [],
      },
      {
        constraints: { choices: [], max: null, max_length: null, min: null },
        description: "Badge one",
        editable: false,
        encoding: null,
        id: "progress.badge_1",
        kind: "read_only_integer",
        label: "Badge 1",
        section_id: 1,
        step: null,
        value: { u32: 1 },
        warnings: [],
      },
    ],
    handler_id: "pokemon-gen3",
    identity: { family: "gen3", id: "pokemon-ruby", name: "Ruby" },
    integrity: { issues: [], state: "valid" },
    platform: "gba",
    save_format: "sav",
    save_format_name: "GBA save",
    save_size: 131072,
    sections: [],
    warnings: [],
  },
});

const recognized = () => ({
  recognition: {
    candidates: [{ confidence: "high", identity: { family: "gen3", id: "pokemon-ruby", name: "Ruby" }, reasons: [] }],
    outcome: {
      recognized: {
        candidate: { confidence: "high", identity: { family: "gen3", id: "pokemon-ruby", name: "Ruby" }, reasons: [] },
      },
    },
    reasons: [],
  },
});

const mount = () => {
  root?.unmount();
  host = document.createElement("div");
  host.className = "rw-app";
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(createElement(SaveEditor, { onSessionChange: vi.fn() }));
};

const uploadSave = async (name = "game.sav") => {
  await page.getByLabelText("Save file").upload(new File(["save"], name, { type: "application/octet-stream" }));
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("ASH");
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listEmulatorSaves.mockResolvedValue([]);
  mocks.identifySave.mockResolvedValue(recognized());
  mocks.inspectSave.mockResolvedValue(documentResult());
  mocks.previewSaveFields.mockResolvedValue({
    preview: {
      changed: true,
      changes: [{ field: "trainer.money" }],
      integrity_recalculated: true,
      output_valid: true,
      touched_sections: [0],
    },
  });
  latestSaveAs = vi.fn();
  mocks.setSaveFields.mockResolvedValue({
    output: {
      dispose: vi.fn(),
      fileName: "game-edited.sav",
      path: "/save-editor/game-edited.sav",
      saveAs: latestSaveAs,
      size: 131072,
      vfs: {},
    },
  });
  mount();
});

test("loads a recognized local save with generic grouped fields", async () => {
  await uploadSave();
  await expect.element(page.getByRole("group", { name: "trainer" })).toBeInTheDocument();
  await expect.element(page.getByRole("group", { name: "progress" })).toBeInTheDocument();
  await expect.element(page.getByLabelText("Money", { exact: true })).toHaveValue(5000);
  await expect.element(page.getByLabelText("Badge 1", { exact: true })).toHaveTextContent("1");
});

test("tracks edits, resets one or all fields, previews, and downloads", async () => {
  await uploadSave();
  await page.getByLabelText("Name", { exact: true }).fill("MAY");
  await page.getByLabelText("Money", { exact: true }).fill("7000");
  await expect.element(page.getByText("ASH → MAY")).toBeInTheDocument();
  await expect.element(page.getByText("5000 → 7000")).toBeInTheDocument();

  await page.getByRole("button", { name: "Preview changes" }).click();
  await expect.element(page.getByText(/field changes/)).toBeInTheDocument();
  expect(mocks.previewSaveFields).toHaveBeenCalledWith(
    expect.objectContaining({ assignments: expect.arrayContaining(["trainer.name=MAY", "trainer.money=7000"]) }),
  );

  await page.getByRole("button", { name: "Reset Name" }).click();
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("ASH");
  await page.getByLabelText("Money", { exact: true }).fill("8000");
  await page.getByRole("button", { name: "Reset all" }).click();
  await expect.element(page.getByLabelText("Money", { exact: true })).toHaveValue(5000);

  await page.getByLabelText("Name", { exact: true }).fill("MAY");
  await page.getByRole("button", { name: "Download edited copy" }).click();
  await expect.poll(() => mocks.setSaveFields.mock.calls.length).toBe(1);
  await expect.poll(() => latestSaveAs.mock.calls.length).toBe(1);
});

test("shows unsupported and ambiguous recognition states", async () => {
  mocks.identifySave.mockResolvedValueOnce({
    recognition: { candidates: [], outcome: { unsupported: { reasons: [] } }, reasons: [] },
  });
  await page.getByLabelText("Save file").upload(new File(["bad"], "bad.sav"));
  await expect.element(page.getByText(/does not have an editor/)).toBeInTheDocument();

  mocks.identifySave.mockResolvedValueOnce({
    recognition: {
      candidates: [
        { confidence: "medium", identity: { family: "gen3", id: "ruby", name: "Ruby" }, reasons: [] },
        { confidence: "medium", identity: { family: "gen3", id: "sapphire", name: "Sapphire" }, reasons: [] },
      ],
      outcome: { ambiguous: { candidates: [] } },
      reasons: [],
    },
  });
  await page.getByLabelText("Save file").upload(new File(["maybe"], "maybe.sav"));
  await expect.element(page.getByText("Choose the game format")).toBeInTheDocument();
  await page.getByRole("button", { name: /Ruby/ }).click();
  await expect.element(page.getByLabelText("Name", { exact: true })).toHaveValue("ASH");
});

test("stays within the mobile page width", async () => {
  await page.viewport(360, 740);
  await uploadSave();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
});
