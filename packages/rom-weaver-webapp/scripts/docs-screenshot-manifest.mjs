const DOCS_SCREENSHOT_CASES = [
  {
    docsRoute: "docs/apply-rom-patches",
    name: "apply-patches",
    route: "/apply?bundle=first-weave.zip",
    target: "#rom-weaver-row-patch-stack",
    waitFor: "Changes HELLO to MODIFIED in the message displayed by the NES ROM.",
  },
  {
    docsRoute: "docs/apply-rom-patches",
    hideDock: true,
    name: "apply-output",
    route: "/apply?bundle=first-weave.zip",
    target: "#rom-weaver-row-output-file-name",
    waitFor: "Changes HELLO to MODIFIED in the message displayed by the NES ROM.",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-rom-patches",
    name: "create-inputs",
    route: "/create?guide=create",
    target: "#patch-builder-row-original, .swap-row, #patch-builder-row-modified",
    waitFor: "Checksum from extract",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-rom-patches",
    name: "create-output",
    route: "/create?guide=create",
    target: "#patch-builder-row-output",
    waitFor: "Checksum from extract",
  },
  {
    dismissGuide: true,
    docsRoute: "docs/create-bundles",
    hideDock: true,
    name: "bundle-output",
    openBundleJob: true,
    route: "/apply?guide=bundle",
    target: "#rom-weaver-bundle-job",
    waitFor: "Changes HELLO to MODIFIED in the message displayed by the NES ROM.",
  },
];
const DOCS_SCREENSHOT_VIEWPORTS = [
  { name: "desktop", viewport: { width: 1164, height: 900 }, deviceScaleFactor: 2, isMobile: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const DOCS_SCREENSHOT_THEMES = ["light", "dark"];
const DOCS_SCREENSHOT_FORMATS = [
  { extension: "avif", imageMagickArgs: ["-quality", "80", "avif:-"] },
  {
    extension: "webp",
    imageMagickArgs: ["-define", "webp:lossless=true", "-define", "webp:method=6", "webp:-"],
  },
];
const DOCS_SCREENSHOT_NAMES = [
  ...DOCS_SCREENSHOT_CASES.flatMap(({ name }) =>
    DOCS_SCREENSHOT_VIEWPORTS.flatMap(({ name: viewport }) =>
      DOCS_SCREENSHOT_THEMES.flatMap((theme) =>
        DOCS_SCREENSHOT_FORMATS.map(({ extension }) => `${name}-${viewport}-${theme}.${extension}`),
      ),
    ),
  ),
  "first-sample-hello-world.webp",
  "first-sample-modified-world.webp",
  "first-sample-modified-rom.webp",
];

export {
  DOCS_SCREENSHOT_CASES,
  DOCS_SCREENSHOT_FORMATS,
  DOCS_SCREENSHOT_NAMES,
  DOCS_SCREENSHOT_THEMES,
  DOCS_SCREENSHOT_VIEWPORTS,
};
