const GUIDED_SAMPLE_VIEWS = {
  apply: "patcher",
  bundle: "patcher",
  create: "creator",
  test: "test",
} as const;

type GuidedSample = keyof typeof GUIDED_SAMPLE_VIEWS;

const GUIDED_SAMPLE_HREFS = {
  apply: "/apply?guide=apply",
  bundle: "/apply?guide=bundle",
  create: "/create?guide=create",
  test: "/test?guide=test",
} as const;

const readGuidedSampleFromSearch = (search: string): GuidedSample | null => {
  const value = new URLSearchParams(search).get("guide");
  return value && Object.prototype.hasOwnProperty.call(GUIDED_SAMPLE_VIEWS, value) ? (value as GuidedSample) : null;
};

const resolveGuidedSampleHref = (assetBaseUrl: string | undefined, guide: GuidedSample): string => {
  const base = assetBaseUrl?.trim();
  const authoredHref = GUIDED_SAMPLE_HREFS[guide];
  if (!base) return authoredHref;
  try {
    const resolved = new URL(authoredHref.slice(1), base);
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return authoredHref;
  }
};

const GUIDED_SAMPLE_START_EVENT = "rom-weaver:guided-sample-start";
const GUIDED_SAMPLE_VIEW_EVENT = "rom-weaver:guided-sample-view";
const ONBOARDING_DISMISS_EVENT = "rom-weaver:onboarding-dismiss";

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

/** "Don't show this again" on the New here? beacon. The webapp shell persists it
    into the onboardingEnabled setting; embeds without a listener lose nothing -
    the beacon still hides itself for the session. */
const requestOnboardingDismiss = () => {
  window.dispatchEvent(new CustomEvent(ONBOARDING_DISMISS_EVENT));
};

export {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_VIEWS,
  GUIDED_SAMPLE_VIEW_EVENT,
  clearGuidedSampleQuery,
  readGuidedSampleFromSearch,
  resolveGuidedSampleHref,
  type GuidedSample,
  notifyGuidedSampleView,
  ONBOARDING_DISMISS_EVENT,
  requestGuidedSampleStart,
  requestOnboardingDismiss,
};
