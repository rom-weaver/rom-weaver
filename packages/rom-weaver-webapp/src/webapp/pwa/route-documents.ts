// The precache is keyed by the file path the build wrote, not by the URL a visitor
// navigates to, so looking `/docs/apply-rom-patches` up directly never finds the document
// that renders it. Every route ships both a `<slug>/index.html` and a `<slug>.html` copy;
// the index form is the one precached (see the `globPatterns` note in vite.config.mjs),
// and the other is kept as a fallback so a manifest change cannot silently strand a route.
export const routeDocumentCandidates = (pathname: string): string[] => {
  const trimmed = pathname.replace(/\/+$/, "").replace(/^\/+/, "");
  if (!trimmed) return [];
  if (/(^|\/)index\.html$/i.test(trimmed)) return [trimmed];
  if (/\.html$/i.test(trimmed)) {
    const route = trimmed.slice(0, -".html".length);
    return [trimmed, `${route}/index.html`];
  }
  return [`${trimmed}/index.html`, `${trimmed}.html`];
};
