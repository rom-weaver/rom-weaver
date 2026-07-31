type GuidedSample = "apply" | "bundle" | "create";

const GUIDED_SAMPLE_START_EVENT = "rom-weaver:guided-sample-start";
const GUIDED_SAMPLE_VIEW_EVENT = "rom-weaver:guided-sample-view";
const ONBOARDING_DISMISS_EVENT = "rom-weaver:onboarding-dismiss";

const requestGuidedSampleStart = (guide: GuidedSample) => {
  window.dispatchEvent(new CustomEvent<GuidedSample>(GUIDED_SAMPLE_START_EVENT, { detail: guide }));
};

const notifyGuidedSampleView = (view: string) => {
  window.dispatchEvent(new CustomEvent<string>(GUIDED_SAMPLE_VIEW_EVENT, { detail: view }));
};

/** "Don't show this again" on the New here? beacon. The webapp shell persists it
    into the onboardingEnabled setting; embeds without a listener lose nothing -
    the beacon still hides itself for the session. */
const requestOnboardingDismiss = () => {
  window.dispatchEvent(new CustomEvent(ONBOARDING_DISMISS_EVENT));
};

export {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_VIEW_EVENT,
  type GuidedSample,
  notifyGuidedSampleView,
  ONBOARDING_DISMISS_EVENT,
  requestGuidedSampleStart,
  requestOnboardingDismiss,
};
