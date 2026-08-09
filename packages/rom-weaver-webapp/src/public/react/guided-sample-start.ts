type GuidedSample = "apply" | "bundle" | "create";

const GUIDED_SAMPLE_HREFS = {
  apply: "/apply?guide=apply",
  bundle: "/apply?guide=bundle",
  create: "/create?guide=create",
} as const;

const GUIDED_SAMPLE_START_EVENT = "rom-weaver:guided-sample-start";
const GUIDED_SAMPLE_VIEW_EVENT = "rom-weaver:guided-sample-view";
const ONBOARDING_DISMISS_EVENT = "rom-weaver:onboarding-dismiss";
const STATUS_VIEW_EVENT = "rom-weaver:open-status";

const requestGuidedSampleStart = (guide: GuidedSample) => {
  window.dispatchEvent(new CustomEvent<GuidedSample>(GUIDED_SAMPLE_START_EVENT, { detail: guide }));
};

const notifyGuidedSampleView = (view: string) => {
  window.dispatchEvent(new CustomEvent<string>(GUIDED_SAMPLE_VIEW_EVENT, { detail: view }));
};

const clearGuidedSampleQuery = () => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("guide")) return;
  url.searchParams.delete("guide");
  window.history.replaceState(window.history.state, "", url);
};

/** "Don't show this guide again" on the New here? beacon. The beacon persists
    its own per-guide flag; the event only tells a host which guide it was, so a
    host can mirror the choice. It must NOT turn onboarding off globally - that
    hid guides the user had never seen. */
const requestOnboardingDismiss = (guide: string) => {
  window.dispatchEvent(new CustomEvent<string>(ONBOARDING_DISMISS_EVENT, { detail: guide }));
};

/** Ask the host shell to open its Status panel - the one place a failed startup
    can be diagnosed. Embeds without a listener simply do nothing. */
const requestStatusView = () => {
  window.dispatchEvent(new CustomEvent(STATUS_VIEW_EVENT));
};

export {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_HREFS,
  GUIDED_SAMPLE_VIEW_EVENT,
  clearGuidedSampleQuery,
  type GuidedSample,
  notifyGuidedSampleView,
  ONBOARDING_DISMISS_EVENT,
  requestGuidedSampleStart,
  requestOnboardingDismiss,
  requestStatusView,
  STATUS_VIEW_EVENT,
};
