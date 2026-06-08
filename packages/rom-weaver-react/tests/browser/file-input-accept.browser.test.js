import { ROM_WEAVER_FILE_FILTERS } from "rom-weaver-wasm/format-metadata";
import { expect, test } from "vitest";
import { getFileInputAcceptAttributes } from "../../src/public/react/file-input-accept.ts";

const stripLeadingExtensionDot = (extension) => extension.replace(/^\./, "");
const unique = (values) => [...new Set(values)];

test("patch file input accept list follows generated format metadata", () => {
  const patchExtensions = ROM_WEAVER_FILE_FILTERS.patchExtensions.map(stripLeadingExtensionDot);
  const expected = [
    ...unique([...patchExtensions, ...patchExtensions.map((extension) => `${extension}1`)]),
    ...ROM_WEAVER_FILE_FILTERS.containerExtensions.map(stripLeadingExtensionDot),
  ].map((extension) => `.${extension}`);

  expect(getFileInputAcceptAttributes({ userAgent: "Chrome" }).patch.split(",")).toEqual(expected);
});
