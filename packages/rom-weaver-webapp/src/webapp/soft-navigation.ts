import { readWorkflowViewFromPath } from "./webapp-controller.ts";

const isPlainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

const getSoftNavigationUrl = (event: MouseEvent, anchor: HTMLAnchorElement, currentUrl: URL): URL | null => {
  if (!isPlainLeftClick(event) || event.defaultPrevented) return null;
  if (anchor.target && anchor.target !== "_self") return null;
  if (anchor.hasAttribute("download")) return null;

  // Fragment-only links MUST stay on this route even when <base> points at the app root.
  const href = anchor.getAttribute("href");
  const url = new URL(href?.startsWith("#") ? href : anchor.href, currentUrl.href);
  if (url.origin !== currentUrl.origin || url.protocol !== currentUrl.protocol) return null;
  if (!readWorkflowViewFromPath(url.pathname)) return null;
  return url;
};

export { getSoftNavigationUrl };
