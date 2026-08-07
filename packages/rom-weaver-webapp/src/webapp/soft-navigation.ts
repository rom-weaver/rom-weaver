import { readWorkflowViewFromPath } from "./webapp-controller.ts";

const isPlainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

const getSoftNavigationUrl = (event: MouseEvent, anchor: HTMLAnchorElement, currentUrl: URL): URL | null => {
  if (!isPlainLeftClick(event) || event.defaultPrevented) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  const url = new URL(anchor.href, currentUrl.href);
  if (url.origin !== currentUrl.origin || url.protocol !== currentUrl.protocol) return null;
  // A fragment on the page already open is the browser's job: it is a
  // same-document jump, needs no route work, and only the browser sets
  // `:target`, which `pushState` leaves untouched. Compared exactly, because
  // any other path - even the same page with a trailing slash - is a real
  // navigation the router should still absorb.
  if (url.hash && url.pathname === currentUrl.pathname) return null;
  if (!readWorkflowViewFromPath(url.pathname)) return null;
  return url;
};

export { getSoftNavigationUrl };
