import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import { WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

export const MARKDOWN_ROUTES = Object.freeze([
  { path: "/", markdownPath: "/index.md" },
  ...[...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]
    .filter(({ slug }) => slug)
    .map(({ slug }) => ({ path: `/${slug}`, markdownPath: `/${slug}.md`, alternateLink: true })),
  ...DOC_SOURCES.map(({ slug }) => ({ path: `/${slug}`, markdownPath: `/${slug}.md` })),
]);
