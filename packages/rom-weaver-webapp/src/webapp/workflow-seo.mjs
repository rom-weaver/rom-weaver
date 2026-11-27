import { readExtensionlessRoutePath } from "./app-route-path.mjs";

const SITE_NAME = "rom-weaver";
const SITE_ALTERNATE_NAMES = Object.freeze(["RomWeaver", "Rom Weaver", "rom weaver"]);

const WORKFLOW_SEO_ROUTES = Object.freeze({
  weave: Object.freeze({
    description:
      "Package multiple ROM patches, their order, and checksums into one weave locally in your browser, then apply with verification. No uploads.",
    slug: "weave-rom-patches",
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
      "Calculate and compare CRC32, MD5, SHA-1, and SHA-256 checksums locally in your browser. Verify ROMs or archive files against expected hashes.",
    slug: "file-checksum",
    title: `CRC32, MD5 & SHA checksum calculator online | ${SITE_NAME}`,
  }),
  compress: Object.freeze({
    description:
      "Convert ISO, BIN/CUE, or GDI to CHD, GameCube/Wii ISO to RVZ, and 3DS ROMs to Z3DS/ZCCI locally in your browser, plus ZIP and 7z. No uploads.",
    slug: "compress-files",
    title: `ISO to CHD & RVZ: Compress ROMs online | ${SITE_NAME}`,
  }),
  extract: Object.freeze({
    description:
      "Convert RVZ to ISO and CHD to ISO, BIN/CUE, or GDI locally in your browser. Extract ZIP, 7z, RAR archives and Z3DS/ZCCI 3DS ROMs. No uploads.",
    slug: "extract-files",
    title: `RVZ to ISO & CHD to ISO converter online | ${SITE_NAME}`,
  }),
  // The apex. An empty slug is deliberate: the canonical URL is the bare origin.
  home: Object.freeze({
    description:
      "Free online ROM patcher and toolkit: apply BPS, IPS, UPS, and xdelta patches, convert CHD or RVZ to ISO, and identify ROMs locally. No uploads.",
    slug: "",
    title: `${SITE_NAME}: Online ROM Patcher & ROM Toolkit`,
  }),
  identify: Object.freeze({
    description:
      "Identify ROMs or check CRC32, MD5, and SHA-1 hashes against known dumps. Find games, regions, and revisions, then inspect known cheat codes. No uploads.",
    slug: "identify-rom",
    title: `ROM identifier & checksum checker online | ${SITE_NAME}`,
  }),
  patcher: Object.freeze({
    description:
      "Apply BPS, IPS, UPS, xdelta, and PPF ROM patches online, including ZIP, 7z, or RAR archives. Add supported cheat codes locally. No uploads.",
    slug: "apply-rom-patches",
    title: `ROM Patcher Online: BPS, IPS, UPS, xdelta & PPF | ${SITE_NAME}`,
  }),
  trim: Object.freeze({
    description:
      "Trim unused padding from Nintendo DS, GBA, 3DS, and Xbox XISO ROMs, or restore padding back to full size, locally in your browser. No uploads.",
    slug: "trim-rom",
    title: `Trim ROMs online: NDS, GBA, 3DS & Xbox | ${SITE_NAME}`,
  }),
  "ppf-undo": Object.freeze({
    description:
      "Undo a PPF3 patch using its stored original bytes and download a restored ROM locally in your browser. Requires the exact patch with undo data. No uploads.",
    slug: "ppf-undo",
    title: `Undo PPF patches online | ${SITE_NAME}`,
  }),
  playlist: Object.freeze({
    description:
      "Make an M3U playlist for a multi-disc game locally in your browser. Rename the discs, arrange the files for your frontend, and download a ZIP. No uploads.",
    slug: "create-m3u-playlist",
    title: `Make M3U playlists for multi-disc games | ${SITE_NAME}`,
  }),
  test: Object.freeze({
    description:
      "Test a ROM or patched game online with EmulatorJS. Play supported NES, SNES, Game Boy, GBA, N64, DS, and PlayStation games locally. No uploads.",
    slug: "play-rom",
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

/**
 * @param {string | undefined} pathname
 * @param {string} [basePath]
 * @returns {keyof typeof WORKFLOW_ENTRY_ROUTES | null}
 */
const readWorkflowEntryFromPathname = (pathname, basePath = "/") => {
  const slug = readExtensionlessRoutePath(pathname, basePath);
  return slug !== null && Object.hasOwn(WORKFLOW_ENTRY_ROUTES, slug)
    ? /** @type {keyof typeof WORKFLOW_ENTRY_ROUTES} */ (slug)
    : null;
};

/**
 * The entry route a page opened on, while that entry's own view is shown; null on any other view.
 * @param {string} view
 * @param {keyof typeof WORKFLOW_ENTRY_ROUTES | null | undefined} workflowEntry
 * @returns {keyof typeof WORKFLOW_ENTRY_ROUTES | null}
 */
const activeWorkflowEntry = (view, workflowEntry) =>
  workflowEntry && WORKFLOW_ENTRY_ROUTES[workflowEntry].view === view ? workflowEntry : null;

// Beta tools stay out of WORKFLOW_SEO_ROUTES (no sitemap, no Markdown twin) but still need their own page title.
const BETA_ROUTE_TITLES = Object.freeze({
  "rom-save-editor": `Save Editor | ${SITE_NAME}`,
  "whats-new": `What's new | ${SITE_NAME}`,
});

/**
 * Mark a page title with the build channel (beta, nightly, dev); production has no badge.
 * @param {string} title
 * @param {string} badge
 * @returns {string}
 */
// A replacer function keeps `$` sequences in the badge literal.
const withChannelBadge = (title, badge) => (badge ? title.replace(SITE_NAME, () => `${SITE_NAME} ${badge}`) : title);

const LEGACY_WORKFLOW_ROUTES = {
  apply: "apply-rom-patches",
  "apply-patch": "apply-rom-patches",
  bundle: "weave-rom-patches",
  "bundle-patches": "weave-rom-patches",
  create: "create-rom-patch",
  "create-patch": "create-rom-patch",
  identify: "identify-rom",
  test: "play-rom",
  trim: "trim-rom",
  weave: "weave-rom-patches",
  "apply-patches": "apply-rom-patches",
  "weave-patches": "weave-rom-patches",
  "save-editor": "rom-save-editor",
  checksum: "file-checksum",
  compress: "compress-files",
  extract: "extract-files",
  "test-rom": "play-rom",
};

export {
  LEGACY_WORKFLOW_ROUTES,
  activeWorkflowEntry,
  WORKFLOW_ENTRY_ROUTES,
  readWorkflowEntryFromPathname,
  BETA_ROUTE_TITLES,
  withChannelBadge,
  SITE_ALTERNATE_NAMES,
  SITE_NAME,
  WORKFLOW_SEO_ROUTES,
};
