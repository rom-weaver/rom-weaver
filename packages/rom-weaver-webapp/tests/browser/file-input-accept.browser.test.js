import { expect, test } from "vitest";
import { getFileInputAcceptAttributes } from "../../src/public/react/file-input-accept.ts";
import { ROM_WEAVER_FILE_FILTERS } from "../../src/wasm/generated/rom-weaver-format-metadata.ts";

const stripLeadingExtensionDot = (extension) => extension.replace(/^\./, "");
const unique = (values) => [...new Set(values)];

const romExtensions = ROM_WEAVER_FILE_FILTERS.romExtensions.map(stripLeadingExtensionDot);
const containerExtensions = ROM_WEAVER_FILE_FILTERS.containerExtensions.map(stripLeadingExtensionDot);
const patchExtensions = ROM_WEAVER_FILE_FILTERS.patchExtensions.map(stripLeadingExtensionDot);
const patchVariants = unique([...patchExtensions, ...patchExtensions.map((extension) => `${extension}1`)]);

test("rom-filter accept list covers ROM and archive extensions", () => {
  const expected = unique([...romExtensions, ...containerExtensions].map((extension) => `.${extension}`));

  expect(getFileInputAcceptAttributes({ userAgent: "Chrome" }).unifiedRom.split(",")).toEqual(expected);
});

test("rom+patch-filter accept list adds patch extensions", () => {
  const expected = unique(
    [...romExtensions, ...containerExtensions, ...patchVariants, "json"].map((extension) => `.${extension}`),
  );

  expect(getFileInputAcceptAttributes({ userAgent: "Chrome" }).unifiedApply.split(",")).toEqual(expected);
});

test("patch-replace accept list covers patch and archive extensions", () => {
  const expected = unique([...patchVariants, ...containerExtensions].map((extension) => `.${extension}`));

  expect(getFileInputAcceptAttributes({ userAgent: "Chrome" }).patchReplace.split(",")).toEqual(expected);
});
