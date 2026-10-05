import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import { WORKFLOW_SEO_ROUTES } from "../src/webapp/workflow-seo.mjs";

export const MARKDOWN_ROUTES = Object.freeze([
  { path: "/", markdownPath: "/index.md" },
  ...Object.values(WORKFLOW_SEO_ROUTES)
    .filter(({ slug }) => slug)
    .map(({ slug }) => ({ path: `/${slug}`, markdownPath: `/${slug}.md` })),
  ...DOC_SOURCES.map(({ slug }) => ({ path: `/${slug}`, markdownPath: `/${slug}.md` })),
]);
