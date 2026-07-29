declare module "virtual:rom-weaver-docs" {
  /** A level-two heading in a guide, used to build the section rail. */
  export type DocSection = {
    id: string;
    label: string;
  };

  /** One published guide, rendered to HTML at build time by scripts/docs-virtual-module.mjs. */
  export type DocRoute = {
    description: string;
    html: string;
    label: string;
    sections: readonly DocSection[];
    slug: string;
    source: string;
    title: string;
  };

  export const DOC_ROUTES: readonly DocRoute[];
}
