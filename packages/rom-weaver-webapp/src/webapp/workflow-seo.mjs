const SITE_NAME = "rom-weaver";
const SITE_ALTERNATE_NAMES = Object.freeze(["RomWeaver", "Rom Weaver", "rom weaver"]);

const WORKFLOW_SEO_ROUTES = Object.freeze({
  bundle: Object.freeze({
    description:
      "Bundle ordered ROM patch workflows locally in your browser, then optionally apply the bundle with checksum validation. No uploads or account required.",
    slug: "bundle-patches",
    title: `${SITE_NAME}: Bundle ROM patches online`,
  }),
  creator: Object.freeze({
    description:
      "Create BPS, IPS, UPS, xdelta, and other ROM patches locally in your browser with checksums and distributable bundles. No uploads or account required.",
    slug: "create-patch",
    title: `${SITE_NAME}: Create ROM patches online`,
  }),
  compress: Object.freeze({
    description:
      "Compress ISO or BIN/CUE to CHD, GameCube and Wii ISO to RVZ, and Nintendo 3DS ROMs to Z3DS in your browser. Create ZIP and 7z archives. No uploads.",
    slug: "compress",
    title: `${SITE_NAME}: Compress ROMs to CHD, RVZ, and Z3DS online`,
  }),
  extract: Object.freeze({
    description:
      "Extract Z3DS, ZCCI, ZCXI, ZCIA, Z3DSX, CHD, RVZ, and supported ROM archives locally in your browser. Download uncompressed files without uploads.",
    slug: "extract",
    title: `${SITE_NAME}: Extract Z3DS files and ROM archives online`,
  }),
  // The apex. An empty slug is deliberate: the canonical URL is the bare origin.
  home: Object.freeze({
    description:
      "Patch ROMs in your browser. Open archives, apply patches in order, and choose your output format. Your files stay on your device. No uploads or account required.",
    slug: "",
    title: `Patch ROMs in your browser | ${SITE_NAME}`,
  }),
  identify: Object.freeze({
    description:
      "Identify a ROM's game, region, revision, and known dump name by checksum, locally in your browser. Nothing is uploaded.",
    slug: "identify-rom",
    title: `${SITE_NAME}: Identify ROMs online`,
  }),
  patcher: Object.freeze({
    description:
      "Apply BPS, IPS, UPS, xdelta, and other ROM patches privately in your browser with checksum validation and ordered patch chains. No uploads or account required.",
    slug: "apply-patches",
    title: `ROM Patcher Online: BPS, IPS, UPS & xdelta | ${SITE_NAME}`,
  }),
  test: Object.freeze({
    description: "Test patched and local ROMs in EmulatorJS directly in your browser. No uploads or account required.",
    slug: "test-rom",
    title: `${SITE_NAME}: Test ROMs online`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
