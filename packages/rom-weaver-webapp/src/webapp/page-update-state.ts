const PAGE_UPDATE_LABEL = "Reload to update";

type PageUpdateState = {
  ready: boolean;
  label: string;
};

type VitePageUpdateState = {
  ready: boolean;
  versionLabel: string;
};

type ViteReloadAvailablePayload = {
  label?: unknown;
  source?: unknown;
};

const createEmptyPageUpdateState = (): PageUpdateState => ({
  label: PAGE_UPDATE_LABEL,
  ready: false,
});

const createEmptyVitePageUpdateState = (): VitePageUpdateState => ({
  ready: false,
  versionLabel: "",
});

const createVitePageUpdateState = (payload?: ViteReloadAvailablePayload): VitePageUpdateState => ({
  ready: true,
  versionLabel: typeof payload?.label === "string" ? payload.label : "",
});

const getPageUpdateState = ({ ready }: Pick<VitePageUpdateState, "ready">): PageUpdateState => ({
  ...createEmptyPageUpdateState(),
  ready,
});

export {
  createEmptyPageUpdateState,
  createEmptyVitePageUpdateState,
  createVitePageUpdateState,
  getPageUpdateState,
  type PageUpdateState,
};
