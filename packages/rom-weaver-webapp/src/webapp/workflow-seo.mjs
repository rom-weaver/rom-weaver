const SITE_NAME = "rom-weaver";
const SITE_ALTERNATE_NAMES = Object.freeze(["RomWeaver", "Rom Weaver", "rom weaver"]);

const WORKFLOW_SEO_ROUTES = Object.freeze({
  creator: Object.freeze({
    description:
      "Create ROM patches locally in your browser with format-aware settings, checksums, and distributable patch bundles. No uploads or account required.",
    slug: "create",
    title: `${SITE_NAME} — Create ROM patches online`,
  }),
  patcher: Object.freeze({
    description:
      "Apply ROM patches privately in your browser with automatic format detection, checksum validation, and ordered patch chains. No uploads or account required.",
    slug: "weave",
    title: `${SITE_NAME} — Apply ROM patches online`,
  }),
});

export { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES };
