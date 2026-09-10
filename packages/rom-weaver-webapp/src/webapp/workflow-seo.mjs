const SITE_NAME = "rom-weaver";
const SITE_ALTERNATE_NAMES = Object.freeze(["RomWeaver", "Rom Weaver", "rom weaver"]);

const WORKFLOW_SEO_ROUTES = Object.freeze({
  creator: Object.freeze({
    description:
      "Create BPS, IPS, UPS, xdelta, and other ROM patches locally in your browser with checksums and distributable bundles. No uploads or account required.",
    slug: "create-patch",
    title: `${SITE_NAME} — Create ROM patches online`,
  }),
  // The apex. An empty slug is deliberate: the canonical URL is the bare origin.
  home: Object.freeze({
    description:
      "Patch, pack, and identify ROMs and disc images locally - in your browser or from the CLI. Nothing is uploaded, and every workflow saves as a replayable bundle.",
    slug: "",
    title: `${SITE_NAME} — Local-first ROM and disc image toolkit`,
  }),
  identify: Object.freeze({
    description:
      "Identify a ROM's game, region, revision, and known dump name by checksum — locally in your browser. Nothing is uploaded.",
    slug: "identify-rom",
    title: `${SITE_NAME} — Identify ROMs online`,
  }),
  patcher: Object.freeze({
    description:
      "Apply BPS, IPS, UPS, xdelta, and other ROM patches privately in your browser with checksum validation and ordered patch chains. No uploads or account required.",
    slug: "apply-patch",
    title: `${SITE_NAME} — Apply ROM patches online`,
  }),
  test: Object.freeze({
    description: "Test patched and local ROMs in EmulatorJS directly in your browser. No uploads or account required.",
    slug: "test-rom",
    title: `${SITE_NAME} — Test ROMs online`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
