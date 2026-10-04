const DOCS_SCREENSHOT_CASES = [
  {
    dismissGuide: true,
    docsRoute: "docs/apply-rom-patches",
    name: "apply-patches",
    route: "/apply-patches?guide=apply",
    target: "#rom-weaver-row-patch-stack",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/apply-rom-patches",
    name: "apply-output",
    route: "/apply-patches?guide=apply",
    target: "#rom-weaver-row-output-file-name",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-rom-patches",
    name: "create-inputs",
    route: "/create-patch?guide=create",
    target: "#patch-builder-row-original, .swap-row, #patch-builder-row-modified",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-rom-patches",
    name: "create-output",
    route: "/create-patch?guide=create",
    target: "#patch-builder-row-output",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-bundles",
    name: "bundle-output",
    route: "/bundle-patches?guide=bundle",
    target: "#rom-weaver-bundle-job",
  },
  {
    docsRoute: "docs/identify-roms-browser",
    name: "identify-checks",
    route: "/identify-rom",
    target: "#identify-container",
  },
  {
    docsRoute: "docs/edit-gen3-saves",
    name: "save-editor",
    route: "/save-editor",
    target: "#save-editor-container",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/test-roms",
    name: "test-player",
    route: "/test-rom?guide=test",
    target: "#emulator-test-player",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/use-cheats",
    name: "cheat-step",
    route: "/apply-patches?guide=apply",
    target: "#rom-weaver-row-patch-stack",
  },
];
const waitForDocsScreenshotReady = async (page, captureCase) => {
  await page.locator("body").waitFor({ state: "visible" });
  if (captureCase.dismissGuide) {
    await page.locator('.sample-tutorial-dialog[aria-busy="false"]').waitFor({ state: "visible" });
  }
  await page.locator(captureCase.target).first().waitFor({ state: "visible" });
};

const DOCS_SCREENSHOT_VIEWPORTS = [
  { name: "desktop", viewport: { width: 1164, height: 900 }, deviceScaleFactor: 2, isMobile: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const DOCS_SCREENSHOT_THEMES = ["light", "dark"];
const DOCS_SCREENSHOT_FORMATS = [{ extension: "avif" }, { extension: "webp" }];
const DOCS_SCREENSHOT_NAMES = [
  ...DOCS_SCREENSHOT_CASES.flatMap(({ name }) =>
    DOCS_SCREENSHOT_VIEWPORTS.flatMap(({ name: viewport }) =>
      DOCS_SCREENSHOT_THEMES.flatMap((theme) =>
        DOCS_SCREENSHOT_FORMATS.map(({ extension }) => `${name}-${viewport}-${theme}.${extension}`),
      ),
    ),
  ),
  "cheat-apply-cheats-desktop-dark.webp",
  "cheat-apply-cheats-mobile-light.webp",
  "cheat-create-cheats-desktop-light.webp",
  "cheat-identify-mobile-dark.webp",
  "first-sample-hello-world.webp",
  "first-sample-rom-world.webp",
  "first-sample-rom-weaver.webp",
  "compress-desktop-light.webp",
  "compress-mobile-dark.webp",
  "compress-select-files-desktop-light.webp",
  "compress-select-files-mobile-dark.webp",
  "checksum-desktop-light.webp",
  "checksum-home-light.webp",
  "checksum-initial-light.webp",
  "checksum-mobile-dark.webp",
];

export {
  waitForDocsScreenshotReady,
  DOCS_SCREENSHOT_CASES,
  DOCS_SCREENSHOT_FORMATS,
  DOCS_SCREENSHOT_NAMES,
  DOCS_SCREENSHOT_THEMES,
  DOCS_SCREENSHOT_VIEWPORTS,
};
