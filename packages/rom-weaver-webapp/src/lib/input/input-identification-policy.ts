const identifySkippedSources = new WeakSet<object>();

const skipSourceIdentification = (source: object): void => {
  identifySkippedSources.add(source);
};

const shouldIdentifySource = (source: unknown): boolean =>
  !(typeof source === "object" && source !== null && identifySkippedSources.has(source));

const inheritSourceIdentificationPolicy = (source: unknown, derivedSource: object): void => {
  if (!shouldIdentifySource(source)) skipSourceIdentification(derivedSource);
};

export { inheritSourceIdentificationPolicy, shouldIdentifySource, skipSourceIdentification };
