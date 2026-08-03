/**
 * The System route's sub-tabs. Each one is a real URL (`/system/logs`), the way
 * every guide under `/docs` is, so the runtime chip, the thread chip and the
 * version chip can link straight at the panel they describe.
 *
 * Shared with the build (vite emits one document per tab) and the SSR
 * prerender, hence `.mjs` rather than `.ts`.
 */

/** Settings leads: it is the tab people come here for. The rest are diagnostics. */
const SYSTEM_TABS = /** @type {const} */ (["settings", "status", "logs", "storage", "changelog"]);

const DEFAULT_SYSTEM_TAB = SYSTEM_TABS[0];

/** @param {unknown} value */
const isSystemTab = (value) => SYSTEM_TABS.includes(/** @type {never} */ (value));

/**
 * The tab a path names, or the default when it names none. `/system`,
 * `/system/`, `/system/index.html` and an unknown sub-slug all land on the
 * default rather than 404ing - the route itself already resolved.
 *
 * @param {string} pathname
 */
const readSystemTabFromPathname = (pathname) => {
  const segments = String(pathname || "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const systemIndex = segments.lastIndexOf("system");
  if (systemIndex < 0) return DEFAULT_SYSTEM_TAB;
  const slug = (segments[systemIndex + 1] || "").replace(/\.html$/, "");
  return isSystemTab(slug) ? slug : DEFAULT_SYSTEM_TAB;
};

/**
 * Every path the build emits a document for. The default tab is served at both
 * `/system` and `/system/settings` so either link resolves offline.
 */
const SYSTEM_ROUTE_SLUGS = ["system", ...SYSTEM_TABS.map((tab) => `system/${tab}`)];

export { readSystemTabFromPathname, SYSTEM_ROUTE_SLUGS, SYSTEM_TABS };
