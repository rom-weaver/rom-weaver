import { describe, expect, it } from "vitest";
import { SITE_NAME, WORKFLOW_SEO_ROUTES, withChannelBadge } from "../../src/webapp/workflow-seo.mjs";

describe("workflow SEO titles", () => {
  it.each(Object.entries(WORKFLOW_SEO_ROUTES).filter(([id]) => id !== "home"))(
    "%s names the page before the site: 'X | rom-weaver'",
    (_id, route) => {
      expect(route.title.endsWith(` | ${SITE_NAME}`) || route.title === SITE_NAME).toBe(true);
      expect(route.title).not.toContain(`${SITE_NAME}:`);
    },
  );

  // The apex leads with the brand so a search for the bare name matches its title.
  it("home leads with the site name: 'rom-weaver: X'", () => {
    expect(WORKFLOW_SEO_ROUTES.home.title.startsWith(`${SITE_NAME}: `)).toBe(true);
  });
});

describe("withChannelBadge", () => {
  it("marks every title shape with the channel and leaves production alone", () => {
    expect(withChannelBadge("What's new | rom-weaver", "Beta")).toBe("What's new | rom-weaver Beta");
    expect(withChannelBadge("Trim ROM | rom-weaver", "Nightly")).toBe("Trim ROM | rom-weaver Nightly");
    expect(withChannelBadge("rom-weaver", "Beta")).toBe("rom-weaver Beta");
    expect(withChannelBadge("What's new | rom-weaver", "")).toBe("What's new | rom-weaver");
  });
});
