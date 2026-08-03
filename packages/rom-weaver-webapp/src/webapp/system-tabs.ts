import {
  readSystemTabFromPathname as readSystemTabSlugFromPathname,
  SYSTEM_TABS as SYSTEM_TAB_SLUGS,
} from "./system-routing.mjs";

/**
 * The tab list lives in `system-routing.mjs` because the build reads it too;
 * this is the typed view of it for the app. Anything that has to agree with the
 * union - the tab label map, the panel ids - fails to compile if the two drift.
 */
type SystemTab = "settings" | "status" | "logs" | "storage" | "changelog";

const SYSTEM_TABS = SYSTEM_TAB_SLUGS as readonly SystemTab[];
const readSystemTabFromPathname = (pathname: string): SystemTab => readSystemTabSlugFromPathname(pathname) as SystemTab;

export { readSystemTabFromPathname, SYSTEM_TABS };
export type { SystemTab };
