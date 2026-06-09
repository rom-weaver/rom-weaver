import type { LogLevel } from "../types/logging.ts";

type WebappEnvironment = {
  DEV?: boolean;
  MODE?: unknown;
};

const isReactWebappDevelopmentMode = (environment: WebappEnvironment = import.meta.env): boolean =>
  environment.DEV === true && String(environment.MODE || "").toLowerCase() === "development";

const getDefaultWebappLogLevel = (environment?: WebappEnvironment): LogLevel =>
  isReactWebappDevelopmentMode(environment) ? "trace" : "warn";

const getDefaultWebappDevToolsEnabled = (environment?: WebappEnvironment): boolean =>
  isReactWebappDevelopmentMode(environment);

export { getDefaultWebappDevToolsEnabled, getDefaultWebappLogLevel };
