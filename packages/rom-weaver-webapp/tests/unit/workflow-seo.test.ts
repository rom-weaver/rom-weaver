import { describe, expect, it } from "vitest";
import { SITE_NAME, WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";

describe("workflow SEO titles", () => {
  it.each(Object.entries(WORKFLOW_SEO_ROUTES))("%s names the page before the site: 'X | rom-weaver'", (_id, route) => {
    expect(route.title.endsWith(` | ${SITE_NAME}`) || route.title === SITE_NAME).toBe(true);
    expect(route.title).not.toContain(`${SITE_NAME}:`);
  });
});
