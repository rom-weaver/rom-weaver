import { expect, test } from "vitest";
import { BETA_WORKFLOW_VIEWS, VIEW_TO_ROUTE_SLUG } from "../../src/webapp/app-routes.ts";
import { BETA_ROUTE_TITLES, WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";

// workflow-seo.mjs is loaded by plain Node scripts, so it cannot import the set.
test.each([...BETA_WORKFLOW_VIEWS])("beta view %s has a beta page title and no indexable SEO route", (view) => {
  const slug = VIEW_TO_ROUTE_SLUG[view];
  expect(BETA_ROUTE_TITLES).toHaveProperty([slug]);
  expect(Object.values(WORKFLOW_SEO_ROUTES).map((route) => route.slug)).not.toContain(slug);
});
