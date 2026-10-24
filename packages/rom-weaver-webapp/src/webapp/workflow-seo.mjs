const SITE_NAME = "rom-weaver";
const SITE_ALTERNATE_NAMES = Object.freeze(["RomWeaver", "Rom Weaver", "rom weaver"]);

const WORKFLOW_SEO_ROUTES = Object.freeze({
  weave: Object.freeze({
    description:
      "Package multiple ROM patches, their order, and expected checksums into one weave locally in your browser, then optionally apply it with checksum validation. No uploads or account required.",
    slug: "weave-patches",
    title: `Package multiple ROM patches into one weave | ${SITE_NAME}`,
  }),
  creator: Object.freeze({
    description:
      "Create BPS, IPS, IPS32, UPS, xdelta, VCDIFF, PPF, and other ROM patches online from modified ROMs or supported cheat codes. No uploads.",
    slug: "create-rom-patch",
    title: `Create ROM patches online | ${SITE_NAME}`,
  }),
  checksum: Object.freeze({
    description:
      "Calculate and compare CRC32, MD5, SHA-1, SHA-256, and other file hashes locally in your browser. Check ROMs or archive contents against expected checksums. No uploads.",
    slug: "checksum",
    title: `CRC32, MD5 & SHA checksum calculator online | ${SITE_NAME}`,
  }),
  compress: Object.freeze({
    description:
      "Compress ISO, BIN/CUE, or GDI disc images to CHD and GameCube or Wii ISO to RVZ locally in your browser. Create Z3DS, ZCCI, ZCXI, ZCIA, or Z3DSX 3DS ROMs, ZIP, and 7z archives. No uploads.",
    slug: "compress",
    title: `ISO to CHD & RVZ: Compress ROMs online | ${SITE_NAME}`,
  }),
  extract: Object.freeze({
    description:
      "Decompress GameCube or Wii RVZ to ISO. Decompress CHD to ISO for DVDs, BIN/CUE for CDs, or GDI with tracks for GD-ROMs locally in your browser. Extract archives and Z3DS, ZCCI, ZCXI, ZCIA, or Z3DSX.",
    slug: "extract",
    title: `RVZ to ISO & CHD to ISO converter online | ${SITE_NAME}`,
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
      "Identify ROMs or check CRC32, MD5, and SHA-1 hashes against known dumps. Find games, regions, and revisions, then inspect known cheat codes. No uploads.",
    slug: "identify-rom",
    title: `ROM identifier & checksum checker online | ${SITE_NAME}`,
  }),
  patcher: Object.freeze({
    description:
      "Apply one or multiple BPS, IPS, UPS, xdelta, and other ROM patches online, in order, including files in ZIP, 7z, or RAR archives. Add supported cheat codes. No uploads.",
    slug: "apply-patches",
    title: `ROM Patcher Online: BPS, IPS, xdelta & multiple patches | ${SITE_NAME}`,
  }),
  "ppf-undo": Object.freeze({
    description:
      "Undo a PPF3 patch using its stored original bytes and download a restored ROM locally in your browser. Requires the exact patch with undo data. No uploads.",
    slug: "ppf-undo",
    title: `Undo PPF patches online | ${SITE_NAME}`,
  }),
  test: Object.freeze({
    description:
      "Test a ROM or patched game online with EmulatorJS. Play supported NES, SNES, Game Boy, GBA, N64, DS, and PlayStation games locally. No uploads.",
    slug: "test-rom",
    title: `ROM tester online: Play and test ROMs | ${SITE_NAME}`,
  }),
});

const WORKFLOW_ENTRY_ROUTES = Object.freeze({
  "apply-cheats": Object.freeze({
    slug: "apply-cheats",
    view: "patcher",
    title: `Apply cheat codes to ROMs online | ${SITE_NAME}`,
    description:
      "Apply supported cheat codes to ROM files locally in your browser and download the modified ROM. No uploads or account required.",
  }),
  "create-rom-cheat-patch": Object.freeze({
    slug: "create-rom-cheat-patch",
    view: "creator",
    title: `Create ROM patches from cheat codes online | ${SITE_NAME}`,
    description:
      "Create a ROM patch from supported cheat codes locally in your browser. Choose a patch format and download the patch without uploading your ROM.",
  }),
});

/** @param {string} pathname @returns {keyof typeof WORKFLOW_ENTRY_ROUTES | null} */
const readWorkflowEntryFromPathname = (pathname) => {
  const segments = pathname.trim().toLowerCase().split("/").filter(Boolean);
  if (segments.includes("docs")) return null;
  if (segments.at(-1) === "index.html") segments.pop();
  const slug = (segments.at(-1) || "").replace(/\.html$/, "");
  return Object.hasOwn(WORKFLOW_ENTRY_ROUTES, slug) ? /** @type {keyof typeof WORKFLOW_ENTRY_ROUTES} */ (slug) : null;
};

// Beta tools stay out of WORKFLOW_SEO_ROUTES (no sitemap, no Markdown twin) but still need their own page title.
const BETA_ROUTE_TITLES = Object.freeze({
  "save-editor": `Save Editor | ${SITE_NAME}`,
  "trim-rom": `Trim ROM | ${SITE_NAME}`,
  "whats-new": `What's new | ${SITE_NAME}`,
});

/**
 * Mark a page title with the build channel (beta, nightly, dev); production has no badge.
 * @param {string} title
 * @param {string} badge
 * @returns {string}
 */
const withChannelBadge = (title, badge) => (badge ? title.replace(SITE_NAME, `${SITE_NAME} ${badge}`) : title);

export {
  WORKFLOW_ENTRY_ROUTES,
  readWorkflowEntryFromPathname,
  BETA_ROUTE_TITLES,
  withChannelBadge,
  SITE_ALTERNATE_NAMES,
  SITE_NAME,
  WORKFLOW_SEO_ROUTES,
};
