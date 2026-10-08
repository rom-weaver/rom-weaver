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
      "Calculate and compare CRC32, MD5, SHA-1, SHA-256, and other file hashes locally in your browser. Check ROMs or archive contents against expected checksums. No uploads.",
    slug: "checksum",
    title: `CRC32, MD5 & SHA checksum calculator online | ${SITE_NAME}`,
  }),
  compress: Object.freeze({
    description:
      "Compress ISO, BIN/CUE, or GDI disc images to CHD and GameCube or Wii ISO to RVZ locally in your browser. Create Z3DS ROMs, ZIP, and 7z archives. No uploads.",
    slug: "compress",
    title: `ISO to CHD & RVZ: Compress ROMs online | ${SITE_NAME}`,
  }),
  extract: Object.freeze({
    description:
      "Convert GameCube or Wii RVZ to ISO. Decompress CHD to ISO for DVDs, BIN/CUE for CDs, or GDI with tracks for GD-ROMs locally in your browser. Extract archives and Z3DS.",
    slug: "extract",
    title: `RVZ to ISO & CHD decompression online | ${SITE_NAME}`,
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
      "Identify ROMs or search CRC32, MD5, and SHA-1 hashes. Find known games, regions, and revisions, then inspect known cheat codes. No uploads.",
    slug: "identify-rom",
    title: `ROM identification & checksum lookup online | ${SITE_NAME}`,
  }),
  patcher: Object.freeze({
    description:
      "Apply BPS, IPS, UPS, xdelta, and other ROM patches online, including files in ZIP, 7z, or RAR archives. Add supported cheat codes. Process files locally with no uploads.",
    slug: "apply-patches",
    title: `ROM Patcher Online: BPS, IPS, UPS, xdelta & PPF | ${SITE_NAME}`,
  }),
  "ppf-undo": Object.freeze({
    description:
      "Undo a PPF3 patch using its stored original bytes and download a restored ROM locally in your browser. Requires the exact patch with undo data. No uploads.",
    slug: "ppf-undo",
    title: `${SITE_NAME}: Undo PPF patches online`,
  }),
  test: Object.freeze({
    description:
      "Play and test NES, SNES, Game Boy, GBA, N64, Nintendo DS, PlayStation, and other supported ROMs online with EmulatorJS. Try patched games locally. No uploads or account required.",
    slug: "test-rom",
    title: `Play and test ROMs online in your browser | ${SITE_NAME}`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
