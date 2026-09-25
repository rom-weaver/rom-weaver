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
  extract: Object.freeze({
    description:
      "Extract supported ROM archives and disc images locally in your browser. Download individual files or an uncompressed ZIP. No uploads or account required.",
    slug: "extract",
    title: `${SITE_NAME}: Extract ROM archives online`,
  }),
  // The apex. An empty slug is deliberate: the canonical URL is the bare origin.
  home: Object.freeze({
    description:
      "A browser ROM toolkit: patch, compress, extract, convert, identify, bake in cheat codes, and edit supported game saves. Works offline after setup. Play supported games with EmulatorJS. No uploads or telemetry.",
    slug: "",
    title: `${SITE_NAME}: Local-first ROM and disc image toolkit`,
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
    title: `${SITE_NAME}: Apply ROM patches online`,
  }),
  test: Object.freeze({
    description: "Test patched and local ROMs in EmulatorJS directly in your browser. No uploads or account required.",
    slug: "test-rom",
    title: `${SITE_NAME}: Test ROMs online`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
