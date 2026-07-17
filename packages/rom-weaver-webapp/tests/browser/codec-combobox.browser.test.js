import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { getCompressionCodecOptions, getCompressionCodecSuggestions } from "../../src/lib/compression/codec-fields.ts";
import { resolveCompressionLevels } from "../../src/lib/compression/compression-settings.ts";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { getProgressStagedInputInfo } from "../../src/public/react/apply-session-inputs.ts";
import { CodecCombobox } from "../../src/public/react/components/ds/codec-combobox.tsx";
import { CompressPanelBody } from "../../src/public/react/components/ds/compress-panel.tsx";
import { buildCompressPanel, OVERRIDDEN_PROFILE_VALUE } from "../../src/public/react/compress-options.ts";

let mountedRoot = null;
let rootElement = null;

const optionTexts = () =>
  Array.from(document.querySelectorAll(".codec-combobox-option")).map((option) => option.textContent || "");
const selectedOptionTexts = () =>
  Array.from(document.querySelectorAll('.codec-combobox-option[aria-selected="true"]')).map(
    (option) => option.textContent || "",
  );

function Harness({ fieldKey, initialValue = "", label, multiple = false }) {
  const [value, setValue] = useState(initialValue);
  return createElement(CodecCombobox, {
    id: "codec-combobox-test",
    label,
    multiple,
    onChange: setValue,
    options: getCompressionCodecOptions(fieldKey),
    suggestions: getCompressionCodecSuggestions(fieldKey),
    value,
  });
}

function ObstructedHarness() {
  const [value, setValue] = useState("deflate");
  return createElement(
    "div",
    { className: "rw-app", style: { paddingTop: "320px", width: "320px" } },
    createElement(CodecCombobox, {
      id: "codec-combobox-test",
      label: "ZIP codec",
      onChange: setValue,
      options: getCompressionCodecOptions("zipCodec"),
      suggestions: getCompressionCodecSuggestions("zipCodec"),
      value,
    }),
    createElement(
      "button",
      { className: "run", style: { height: "52px", marginTop: "16px", width: "320px" }, type: "button" },
      "Weave",
    ),
  );
}

const mountCombobox = (props) => {
  mountedRoot?.unmount?.();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(createElement(Harness, props));
};

const getInput = () => document.querySelector("#codec-combobox-test");

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
});

test("codec combobox opens with expected codec suggestions before typing", async () => {
  mountCombobox({ fieldKey: "zipCodec", label: "ZIP codec" });

  const input = page.getByRole("combobox", { name: "ZIP codec" });
  await input.click();

  expect(optionTexts()).toEqual(["deflate", "store", "zstd"]);

  await input.fill("zs");
  expect(optionTexts()).toEqual(["zstd"]);

  await page.getByRole("option", { name: "zstd" }).click();
  await expect.poll(() => getInput()?.value).toBe("zstd");

  await input.fill("zstd:22");
  expect(getInput()?.getAttribute("aria-invalid")).toBeNull();

  await input.fill("zstd:-7");
  expect(getInput()?.getAttribute("aria-invalid")).toBeNull();

  await input.fill("zstd:-8");
  expect(getInput()?.getAttribute("aria-invalid")).toBe("true");

  await input.fill("zstd:23");
  expect(getInput()?.getAttribute("aria-invalid")).toBe("true");
});

test("chd codec combobox lists zstd and lzma presets before individual codecs", async () => {
  mountCombobox({
    fieldKey: "chdCreateCdCodecs",
    initialValue: "cdlz,",
    label: "CD Codecs",
    multiple: true,
  });

  const cdInput = page.getByRole("combobox", { name: "CD Codecs" });
  await cdInput.click();

  expect(optionTexts()).toEqual([
    "zstd preset: cdzs,cdzl,cdfl",
    "lzma preset: cdlz,cdzl,cdfl",
    "cdzs",
    "cdlz",
    "cdzl",
    "cdfl",
  ]);

  await page.getByRole("option", { name: "zstd preset: cdzs,cdzl,cdfl" }).click();
  await expect.poll(() => getInput()?.value).toBe("cdzs,cdzl,cdfl");

  await cdInput.fill("lzma");
  await expect.poll(optionTexts).toEqual(["lzma preset: cdlz,cdzl,cdfl"]);

  mountCombobox({
    fieldKey: "chdCreateDvdCodecs",
    label: "DVD Codecs",
    multiple: true,
  });

  const dvdInput = page.getByRole("combobox", { name: "DVD Codecs" });
  await dvdInput.click();

  expect(optionTexts()).toEqual([
    "zstd preset: zstd,zlib,huff,flac",
    "lzma preset: lzma,zlib,huff,flac",
    "zstd",
    "lzma",
    "zlib",
    "huff",
    "flac",
  ]);
});

test("chd codec combobox shows matching presets as selected", async () => {
  mountCombobox({
    fieldKey: "chdCreateCdCodecs",
    initialValue: "cdlz,cdzl,cdfl",
    label: "CD Codecs",
    multiple: true,
  });

  await page.getByRole("combobox", { name: "CD Codecs" }).click();
  await expect.poll(selectedOptionTexts).toEqual(["lzma preset: cdlz,cdzl,cdfl"]);

  mountCombobox({
    fieldKey: "chdCreateDvdCodecs",
    initialValue: "zstd,zlib,huff,flac",
    label: "DVD Codecs",
    multiple: true,
  });

  await page.getByRole("combobox", { name: "DVD Codecs" }).click();
  await expect.poll(selectedOptionTexts).toEqual(["zstd preset: zstd,zlib,huff,flac"]);
});

test("codec combobox replaces the active token in multi-codec lists", async () => {
  mountCombobox({
    fieldKey: "chdCreateCdCodecs",
    initialValue: "cdlz,",
    label: "CD Codecs",
    multiple: true,
  });

  const input = page.getByRole("combobox", { name: "CD Codecs" });
  await input.click();
  await page.getByRole("option", { exact: true, name: "cdfl" }).click();

  await expect.poll(() => getInput()?.value).toBe("cdlz,cdfl");

  await input.fill("cdlz:9,cdfl:8");
  expect(getInput()?.getAttribute("aria-invalid")).toBeNull();

  await input.fill("cdzs:-7,cdlz:9");
  expect(getInput()?.getAttribute("aria-invalid")).toBeNull();

  await input.fill("cdzs:-8");
  expect(getInput()?.getAttribute("aria-invalid")).toBe("true");

  await input.fill("cdlz:10");
  expect(getInput()?.getAttribute("aria-invalid")).toBe("true");
});

test("codec combobox portals suggestions above nearby action controls", async () => {
  mountedRoot?.unmount?.();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(createElement(ObstructedHarness));

  const input = page.getByRole("combobox", { name: "ZIP codec" });
  await input.click();

  await expect.poll(() => document.querySelector(".codec-combobox-list")?.parentElement === document.body).toBe(true);
  await expect
    .poll(() => {
      const list = document.querySelector(".codec-combobox-list");
      const inputElement = document.querySelector("#codec-combobox-test");
      const button = document.querySelector(".run");
      const listRect = list?.getBoundingClientRect();
      const inputRect = inputElement?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        aboveButton: !!listRect && !!buttonRect && listRect.bottom <= buttonRect.top,
        adjacentToInput:
          !!listRect && !!inputRect && listRect.bottom <= inputRect.top && inputRect.top - listRect.bottom <= 8,
        gap: Math.round((inputRect?.top ?? 0) - (listRect?.bottom ?? 0)),
        listPosition: list ? getComputedStyle(list).position : "",
      };
    })
    .toEqual({
      aboveButton: true,
      adjacentToInput: true,
      gap: expect.any(Number),
      listPosition: "fixed",
    });
});

test("compress panel keeps cleared codec values editable", () => {
  const zipPanel = buildCompressPanel("zip", { compressionProfile: "max", zipCodec: "" });
  expect(zipPanel?.fields.find((field) => field.key === "zipCodec")?.value).toBe("");
  expect(zipPanel?.summary).toBe("deflate:9");

  const chdPanel = buildCompressPanel(
    "chd",
    {
      chdCreateCdCodecs: "",
      chdOutputMode: "cd",
      compressionProfile: "max",
    },
    {},
  );
  expect(chdPanel?.fields.find((field) => field.key === "chdCreateCdCodecs")?.value).toBe("");
  expect(chdPanel?.summary).toBe("cdlz:9,cdzl:9,cdfl:8");

  expect(buildCompressPanel("zip", { compressionProfile: "max", zipCodec: "store" })?.summary).toBe("store");
  expect(buildCompressPanel("7z", { compressionProfile: "high", sevenZipCodec: "lzma2" })?.summary).toBe("lzma2:7");
  expect(buildCompressPanel("rvz", { compressionProfile: "max", rvzCodec: "zstd" })?.summary).toBe("zstd:22");
  expect(buildCompressPanel("z3ds", { compressionProfile: "max" })?.summary).toBe("zstd:22");
  expect(buildCompressPanel("zip", { compressionProfile: "min", zipCodec: "zstd" })?.summary).toBe("zstd:-7");
  expect(buildCompressPanel("z3ds", { compressionProfile: "min" })?.summary).toBe("zstd:-7");
});

test("chd compress panel uses source mode discovered before extraction finishes", () => {
  const settings = {
    chdCreateCdCodecs: "cdlz,cdzl,cdfl",
    chdCreateDvdCodecs: "zstd,lzma,zlib,huff,flac",
    chdOutputMode: "auto",
    compressionProfile: "max",
  };
  const cdPanel = buildCompressPanel("chd", settings, { fileName: "game.chd", metadata: { mode: "cd" } });
  const dvdPanel = buildCompressPanel("chd", settings, { fileName: "game.chd", metadata: { mode: "dvd" } });

  expect(cdPanel?.fields[0]?.key).toBe("chdCreateCdCodecs");
  expect(cdPanel?.summary).toBe("cdlz:9,cdzl:9,cdfl:8");
  expect(dvdPanel?.fields[0]?.key).toBe("chdCreateDvdCodecs");
  expect(dvdPanel?.summary).toBe("zstd:22,lzma:9,zlib:9,huff,flac:8");
});

test("input progress preserves listed chd mode before extraction finishes", () => {
  const info = getProgressStagedInputInfo({
    details: {
      chdMode: "cd",
      fileName: "game.chd",
      order: 0,
      sourceId: "input-0-game-chd",
      stage: "decompress",
    },
    label: "Preparing CHD extraction...",
    percent: null,
    stage: "decompress",
  });

  expect(info).toMatchObject({
    chdMode: "cd",
    fileName: "game.chd",
    id: "input-0-game-chd",
    order: 0,
  });
});

test("compress panel shows codec level overrides and clears them when level changes", async () => {
  const zstdProfilePanel = buildCompressPanel("zip", {
    compressionProfile: "max",
    zipCodec: "zstd",
  });
  const zstdProfileLevelField = zstdProfilePanel?.fields.find((field) => field.key === "compressionProfile");
  expect(zstdProfileLevelField?.value).toBe("max");
  expect(zstdProfilePanel?.summary).toBe("zstd:22");
  expect(resolveCompressionLevels({ compressionProfile: "max", zipCodec: "zstd" }).zipLevel).toBe(22);
  expect(resolveCompressionLevels({ compressionProfile: "min", zipCodec: "zstd" }).zipLevel).toBe(-7);
  expect(resolveCompressionLevels({ compressionProfile: "min", rvzCodec: "zstd" }).rvzCompressionLevel).toBe(-7);
  expect(resolveCompressionLevels({ compressionProfile: "min" }).z3dsCompressionLevel).toBe(-7);

  const zipPanel = buildCompressPanel("zip", {
    compressionProfile: "max",
    zipCodec: "zstd:12",
  });
  const levelField = zipPanel?.fields.find((field) => field.key === "compressionProfile");
  expect(levelField?.value).toBe(OVERRIDDEN_PROFILE_VALUE);
  expect(zipPanel?.summary).toBe("zstd:12");

  let changed = null;
  mountedRoot?.unmount?.();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(
    createElement(CompressPanelBody, {
      fields: zipPanel?.fields || [],
      onChange: (key, value, updates) => {
        changed = { key, updates, value };
      },
    }),
  );

  await expect.poll(() => document.querySelector('select[aria-label="Level"]')).not.toBeNull();
  const levelSelect = document.querySelector('select[aria-label="Level"]');
  expect(levelSelect).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(levelSelect, "high");
  levelSelect?.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  expect(changed).toEqual({
    key: "compressionProfile",
    updates: {
      compressionProfile: "high",
      zipCodec: "zstd",
    },
    value: "high",
  });
});

test("chd accepts a level override for one codec and clears it when level changes", async () => {
  const chdPanel = buildCompressPanel(
    "chd",
    {
      chdCreateCdCodecs: "cdlz:4,cdzl,cdfl",
      chdOutputMode: "cd",
      compressionProfile: "max",
    },
    {},
  );
  const levelField = chdPanel?.fields.find((field) => field.key === "compressionProfile");
  expect(levelField?.value).toBe(OVERRIDDEN_PROFILE_VALUE);
  expect(chdPanel?.summary).toBe("cdlz:4,cdzl:9,cdfl:8");
  expect(
    OutputCompressionManager.getChdCodecsForMode("cd", {
      chdCreateCdCodecs: "cdlz:4,cdzl,cdfl",
      compressionProfile: "max",
    }),
  ).toBe("cdlz:4,cdzl:9,cdfl:8");

  let changed = null;
  mountedRoot?.unmount?.();
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(
    createElement(CompressPanelBody, {
      fields: chdPanel?.fields || [],
      onChange: (key, value, updates) => {
        changed = { key, updates, value };
      },
    }),
  );

  await expect.poll(() => document.querySelector('select[aria-label="Level"]')).not.toBeNull();
  const levelSelect = document.querySelector('select[aria-label="Level"]');
  expect(levelSelect).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(levelSelect, "high");
  levelSelect?.dispatchEvent(new Event("change", { bubbles: true }));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  expect(changed).toEqual({
    key: "compressionProfile",
    updates: {
      chdCreateCdCodecs: "cdlz,cdzl,cdfl",
      compressionProfile: "high",
    },
    value: "high",
  });

  const highPanel = buildCompressPanel(
    "chd",
    {
      chdCreateCdCodecs: "cdlz,cdzl,cdfl",
      chdOutputMode: "cd",
      compressionProfile: "high",
    },
    {},
  );
  expect(highPanel?.summary).toBe("cdlz:7,cdzl:7,cdfl:7");
});
