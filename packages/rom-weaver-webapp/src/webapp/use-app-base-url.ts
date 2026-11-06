import { useSyncExternalStore } from "react";
import { readAppBaseUrl } from "./app-routes.ts";

// A fixed value never notifies, so there is nothing to unsubscribe.
const subscribeNever = () => () => undefined;
const readPrerenderedBaseUrl = () => "/";

/**
 * Where the app is served. The prerendered document is written against "/", so
 * hydration reads that and the real base (a sub-path deployment keeps its
 * prefix) applies on the render right after, which avoids hydration mismatches.
 */
const useAppBaseUrl = (): string => useSyncExternalStore(subscribeNever, readAppBaseUrl, readPrerenderedBaseUrl);

export { useAppBaseUrl };
