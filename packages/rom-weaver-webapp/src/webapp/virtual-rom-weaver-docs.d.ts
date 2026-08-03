declare module "virtual:rom-weaver-docs" {
  /** A level-two heading in a guide, used to build the section rail. */
  export type DocSection = {
    id: string;
    label: string;
  };

  /**
   * One published guide's metadata, rendered at build time by
   * scripts/docs-virtual-module.mjs. The guide's HTML is deliberately absent:
   * it ships as its own lazy chunk behind `DOC_PAGE_LOADERS` so a docs visit
   * only downloads the page being read.
   */
  export type DocRoute = {
    description: string;
    /** Shelf this guide sits on, from the folder it lives in under `docs/`. */
    group: string;
    label: string;
    sections: readonly DocSection[];
    slug: string;
    source: string;
    title: string;
  };

  export const DOC_ROUTES: readonly DocRoute[];

  /** One loader per route slug; each resolves that guide's rendered HTML chunk. */
  export const DOC_PAGE_LOADERS: Readonly<Record<string, () => Promise<{ html: string }>>>;
}

declare module "virtual:rom-weaver-docs-search" {
  /** One searchable block of a guide: the intro (`id: null`) or one `<h2>` section. */
  export type DocSearchEntry = {
    id: string | null;
    label: string;
    text: string;
  };

  /** Prebuilt search entries keyed by route slug; plain text only, no HTML. */
  export const SEARCH_ENTRIES: Readonly<Record<string, readonly DocSearchEntry[]>>;
}
