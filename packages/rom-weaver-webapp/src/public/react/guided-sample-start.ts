type GuidedSample = "apply" | "bundle" | "create";

const GUIDED_SAMPLE_START_EVENT = "rom-weaver:guided-sample-start";
const GUIDED_SAMPLE_VIEW_EVENT = "rom-weaver:guided-sample-view";

const requestGuidedSampleStart = (guide: GuidedSample) => {
  window.dispatchEvent(new CustomEvent<GuidedSample>(GUIDED_SAMPLE_START_EVENT, { detail: guide }));
};

const notifyGuidedSampleView = (view: string) => {
  window.dispatchEvent(new CustomEvent<string>(GUIDED_SAMPLE_VIEW_EVENT, { detail: view }));
};

export {
  GUIDED_SAMPLE_START_EVENT,
  GUIDED_SAMPLE_VIEW_EVENT,
  type GuidedSample,
  notifyGuidedSampleView,
  requestGuidedSampleStart,
};
