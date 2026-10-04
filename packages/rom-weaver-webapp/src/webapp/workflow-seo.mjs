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
      "Create BPS, IPS, IPS32, UPS, xdelta, VCDIFF, PPF, and other ROM patches online from modified ROMs or supported cheat codes. No uploads.",
    slug: "create-patch",
    title: `${SITE_NAME}: Create ROM patches online`,
  }),
  checksum: Object.freeze({
    description:
      "Calculate CRC32, MD5, SHA-1, SHA-256, and other checksums of any file locally in your browser, with optional archive extraction. Compare them with an expected value. No uploads or account required.",
    slug: "checksum",
    title: `${SITE_NAME}: Checksum a file online`,
  }),
  compress: Object.freeze({
    description:
      "Compress ISO or BIN/CUE to CHD, GameCube and Wii ISO to RVZ, and Nintendo 3DS ROMs to Z3DS in your browser. Create ZIP and 7z archives. No uploads.",
    slug: "compress",
    title: `${SITE_NAME}: Compress ROMs to CHD, RVZ, and Z3DS online`,
  }),
  extract: Object.freeze({
    description:
      "Convert RVZ to ISO, extract CHD to ISO or BIN/CUE, and decompress Z3DS, ZCCI, ZCXI, ZCIA, and Z3DSX locally in your browser. No uploads.",
    slug: "extract",
    title: `RVZ to ISO, CHD & Z3DS extractor online | ${SITE_NAME}`,
  }),
  // The apex. An empty slug is deliberate: the canonical URL is the bare origin.
  home: Object.freeze({
    description:
      "Patch ROMs in your browser, including files inside ZIP, 7z, and RAR archives. Apply patches in order and bake supported cheat codes. No uploads or account required.",
    slug: "",
    title: `Patch ROMs in your browser | ${SITE_NAME}`,
  }),
  identify: Object.freeze({
    description:
      "Identify a ROM by checksum: look up its game, region, revision, and known dump name, then inspect known cheat codes. Your file stays in your browser.",
    slug: "identify-rom",
    title: `${SITE_NAME}: Identify ROMs online`,
  }),
  patcher: Object.freeze({
    description:
      "Apply BPS, IPS, UPS, xdelta, and other ROM patches online, including files in ZIP, 7z, or RAR archives. Add supported cheat codes. Process files locally with no uploads.",
    slug: "apply-patches",
    title: `ROM Patcher Online: BPS, IPS, UPS, xdelta & PPF | ${SITE_NAME}`,
  }),
  test: Object.freeze({
    description: "Test patched and local ROMs in EmulatorJS directly in your browser. No uploads or account required.",
    slug: "test-rom",
    title: `${SITE_NAME}: Test ROMs online`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
